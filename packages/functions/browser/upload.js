/*
 * Run402 delegated uploads — the browser half. The page imports it
 *
 *   import { uploadFile } from "@run402/functions/browser/upload.js";
 *   const asset = await uploadFile(file, { endpoint: "/api/uploads", onProgress });
 *
 * and talks to a function that serves `uploads.handler(...)` at `endpoint`.
 * The bytes go straight from this page to storage through presigned part URLs;
 * the app's server never carries them.
 *
 * What it does for you:
 *   - sends up to `concurrency` parts at once (default 4), each of at most 8 MiB;
 *   - retries a failed part with backoff, and waits for the connection to come
 *     back when the phone goes offline;
 *   - fetches fresh URLs when a batch runs out or expires;
 *   - reports `{ bytes_done, size, fraction }` after each part;
 *   - remembers the upload in IndexedDB, so when the page reloads and the user
 *     picks the same file again, it resumes, sending only what storage lacks;
 *   - completes, waits for verification, and resolves to the stored asset.
 * It computes no hash: the server hashes the finished file.
 *
 * Failures reject with an Error whose `.code` says what happened:
 * "aborted" (your `signal`), "upload_failed" (with `.upload`, the server's
 * verdict), or the server's own code with `.status` (e.g. "QUOTA_EXCEEDED",
 * "UPLOAD_REFUSED", "AUTH_REQUIRED").
 *
 * Plain ES2018 module, no dependencies.
 */

var DB_NAME = "run402-uploads";
var STORE = "uploads";
var MAX_PART_ATTEMPTS = 8;

function fail(code, message, extra) {
  var err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function sleep(ms, signal) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", function () { clearTimeout(t); reject(fail("aborted", "Upload aborted")); }, { once: true });
    }
  });
}

function checkAbort(signal) {
  if (signal && signal.aborted) throw fail("aborted", "Upload aborted");
}

// ---- IndexedDB memory (best-effort: a browser without it just cannot resume) ----

function openDb(env) {
  return new Promise(function (resolve) {
    if (!env.indexedDB) return resolve(null);
    var req;
    try { req = env.indexedDB.open(DB_NAME, 1); } catch (_e) { return resolve(null); }
    req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { resolve(null); };
  });
}

function idb(env, mode, fn) {
  return openDb(env).then(function (db) {
    if (!db) return null;
    return new Promise(function (resolve) {
      var tx = db.transaction(STORE, mode);
      var req = fn(tx.objectStore(STORE));
      tx.oncomplete = function () { resolve(req && req.result !== undefined ? req.result : null); };
      tx.onerror = function () { resolve(null); };
    });
  }).catch(function () { return null; });
}

function memoryKey(endpoint, file) {
  return [endpoint, file.name, file.size, file.lastModified || 0].join("|");
}

// ---- Talking to the handler ----------------------------------------------------

function joinUrl(endpoint, suffix) {
  return endpoint.replace(/\/+$/, "") + suffix;
}

function api(env, method, url, body, opts) {
  var init = { method: method, credentials: opts.credentials || "same-origin", headers: Object.assign({}, opts.headers || {}) };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (opts.signal) init.signal = opts.signal;
  return env.fetch(url, init).then(function (res) {
    return res.text().then(function (text) {
      var parsed = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch (_e) { parsed = { message: text }; }
      if (!res.ok) {
        throw fail(parsed.code || "http_" + res.status, parsed.message || "Upload request failed (" + res.status + ")", {
          status: res.status,
          details: parsed.details,
          next_actions: parsed.next_actions,
        });
      }
      return parsed;
    });
  });
}

// ---- One upload -------------------------------------------------------------------

function partLength(state, n) {
  var start = (n - 1) * state.part_size_bytes;
  return Math.min(state.part_size_bytes, state.size_bytes - start);
}

/** Resume a remembered upload, or open a new one. */
function begin(env, file, opts) {
  var key = memoryKey(opts.endpoint, file);
  return idb(env, "readonly", function (s) { return s.get(key); }).then(function (remembered) {
    if (!remembered) return open();
    return api(env, "GET", joinUrl(opts.endpoint, "/" + remembered), undefined, opts).then(function (state) {
      if (state.status === "active" || state.status === "verifying" || state.status === "completed") return state;
      return forget().then(open);
    }, function (err) {
      if (err.status === 404) return forget().then(open);
      throw err;
    });
  });

  function open() {
    return api(env, "POST", opts.endpoint, { name: file.name, size: file.size, type: file.type || "application/octet-stream" }, opts)
      .then(function (state) {
        return idb(env, "readwrite", function (s) { return s.put(state.upload_id, key); }).then(function () { return state; });
      });
  }
  function forget() {
    return idb(env, "readwrite", function (s) { return s.delete(key); });
  }
}

function forgetFile(env, file, opts) {
  return idb(env, "readwrite", function (s) { return s.delete(memoryKey(opts.endpoint, file)); });
}

/** Send every part storage lacks, `concurrency` at a time. */
function sendParts(env, file, state, opts) {
  var id = state.upload_id;
  var done = new Set(state.parts_done || []);
  var urls = new Map();
  (state.parts || []).forEach(function (p) { urls.set(p.part_number, p.url); });
  var queue = [];
  for (var n = 1; n <= state.part_count; n++) if (!done.has(n)) queue.push(n);
  var bytesDone = 0;
  done.forEach(function (d) { bytesDone += partLength(state, d); });
  var renewing = null;

  function report() {
    if (opts.onProgress) opts.onProgress({ upload_id: id, bytes_done: bytesDone, size: state.size_bytes, fraction: state.size_bytes ? bytesDone / state.size_bytes : 1 });
  }

  function renew(partNumbers) {
    if (!renewing) {
      renewing = api(env, "POST", joinUrl(opts.endpoint, "/" + id + "/urls"), { part_numbers: partNumbers.slice(0, 64) }, opts)
        .then(function (fresh) {
          (fresh.parts || []).forEach(function (p) { urls.set(p.part_number, p.url); });
        })
        .finally(function () { renewing = null; });
    }
    return renewing;
  }

  function urlFor(part) {
    if (urls.has(part)) return Promise.resolve(urls.get(part));
    var wanted = [part].concat(queue.filter(function (q) { return !urls.has(q); }));
    return renew(wanted).then(function () { return urlFor(part); });
  }

  function sendOnce(part, url) {
    var start = (part - 1) * state.part_size_bytes;
    var body = file.slice(start, start + partLength(state, part));
    var headers = state.mode === "single" ? { "content-type": state.content_type } : {};
    var init = { method: "PUT", body: body, headers: headers };
    if (opts.signal) init.signal = opts.signal;
    return env.fetch(url, init);
  }

  function waitForNetwork() {
    if (!env.navigator || env.navigator.onLine !== false || !env.addEventListener) return Promise.resolve();
    return new Promise(function (resolve) { env.addEventListener("online", resolve, { once: true }); });
  }

  function send(part, attempt) {
    checkAbort(opts.signal);
    return urlFor(part).then(function (url) { return sendOnce(part, url); }).then(function (res) {
      if (res.ok) {
        bytesDone += partLength(state, part);
        report();
        return;
      }
      if (res.status === 403 || res.status === 400) {
        // An expired or refused URL: drop it, sign again, retry.
        urls.delete(part);
      }
      throw fail("part_" + res.status, "Part " + part + " answered " + res.status, { status: res.status });
    }).catch(function (err) {
      if (err.code === "aborted" || (opts.signal && opts.signal.aborted)) throw fail("aborted", "Upload aborted");
      if (err.status !== undefined && err.status !== 403 && err.status !== 400 && err.status < 500 && !String(err.code).startsWith("part_")) throw err;
      if (attempt >= MAX_PART_ATTEMPTS) throw fail("part_failed", "Part " + part + " failed after " + attempt + " attempts", { cause: err });
      var delay = Math.min(30000, opts.retryBaseMs * Math.pow(2, attempt - 1));
      return waitForNetwork().then(function () { return sleep(delay, opts.signal); }).then(function () { return send(part, attempt + 1); });
    });
  }

  function worker() {
    var part = queue.shift();
    if (part === undefined) return Promise.resolve();
    return send(part, 1).then(worker);
  }

  report();
  var workers = [];
  for (var w = 0; w < Math.max(1, opts.concurrency); w++) workers.push(worker());
  return Promise.all(workers);
}

/** Complete, then poll until verification ends. */
function finish(env, state, opts) {
  var id = state.upload_id;
  var poll = function (attempt) {
    return api(env, "GET", joinUrl(opts.endpoint, "/" + id), undefined, opts).then(function (s) {
      if (s.status === "verifying") return sleep(Math.min(10000, opts.pollMs * Math.pow(1.5, attempt)), opts.signal).then(function () { return poll(attempt + 1); });
      return s;
    });
  };
  var start = state.status === "verifying" || state.status === "completed"
    ? Promise.resolve(state)
    : api(env, "POST", joinUrl(opts.endpoint, "/" + id + "/complete"), {}, opts);
  return start.then(function (s) { return s.status === "verifying" ? poll(0) : s; });
}

/**
 * Upload `file` through the handler at `endpoint`; resolves to the stored asset.
 *
 * Options: `endpoint` (required), `concurrency` (4), `onProgress(p)`,
 * `signal` (AbortSignal: stops sending; the upload stays resumable),
 * `headers` (extra headers for the handler calls, e.g. Authorization),
 * `credentials` ("same-origin").
 */
export function uploadFile(file, options) {
  var env = options && options.env ? options.env : globalThis;
  var opts = Object.assign({ concurrency: 4, retryBaseMs: 1000, pollMs: 2000 }, options || {});
  if (!opts.endpoint) return Promise.reject(fail("invalid_options", "uploadFile: endpoint is required"));
  if (!file || typeof file.slice !== "function" || typeof file.size !== "number") {
    return Promise.reject(fail("invalid_options", "uploadFile: file must be a File or Blob"));
  }
  return begin(env, file, opts).then(function (state) {
    if (state.status === "completed") return state;
    var ready = state.status === "active" ? sendParts(env, file, state, opts) : Promise.resolve();
    return ready.then(function () { return finish(env, state, opts); });
  }).then(function (final) {
    if (final.status === "completed") {
      return forgetFile(env, file, opts).then(function () { return final.asset; });
    }
    return forgetFile(env, file, opts).then(function () {
      var reason = final.error ? final.error.code + ": " + final.error.message : final.status;
      throw fail("upload_failed", "Upload " + final.status + " (" + reason + ")", { upload: final });
    });
  });
}

export default { uploadFile: uploadFile };
