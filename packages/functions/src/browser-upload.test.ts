// `browser/upload.js` runs in pages. It takes its browser objects (fetch,
// indexedDB, navigator) from `options.env`, so these tests hand it fakes: a
// gateway handler, an S3 that can drop requests, and an in-memory IndexedDB.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// @ts-expect-error — plain JS module without declarations
const { uploadFile } = await import("../browser/upload.js");

const MiB = 1024 * 1024;
const PART = 8 * MiB;
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function fakeFile(size: number, name = "scans.zip", type = "application/zip") {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) bytes[i] = (i / 4096) % 251;
  const blob = new Blob([bytes], { type });
  return Object.assign(blob, { name, lastModified: 1700000000000 });
}

/** A minimal IndexedDB: one store, get/put/delete, completing transactions. */
function fakeIndexedDb() {
  const data = new Map<string, unknown>();
  const store = {
    get: (k: string) => req(data.get(k)),
    put: (v: unknown, k: string) => { data.set(k, v); return req(k); },
    delete: (k: string) => { data.delete(k); return req(undefined); },
  };
  function req(result: unknown) { return { result }; }
  const db = {
    transaction: () => {
      const tx: { objectStore: () => typeof store; oncomplete?: () => void; onerror?: () => void } = { objectStore: () => store };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    },
  };
  return {
    data,
    open: () => {
      const r: { result: typeof db; onsuccess?: () => void; onupgradeneeded?: () => void; onerror?: () => void } = { result: db };
      setTimeout(() => r.onsuccess?.(), 0);
      return r;
    },
  };
}

interface World {
  parts: Map<number, number>;
  puts: number;
  apiCalls: string[];
  dropEvery: number;
  expireFirst: Set<number>;
  status: string;
  stopAfterParts: number;
}

function env(size: number, w: World, idb = fakeIndexedDb()) {
  const partCount = size <= PART ? 1 : Math.ceil(size / PART);
  const mode = size <= PART ? "single" : "multipart";
  const base = () => ({
    upload_id: ID, key: "k", status: w.status, mode, size_bytes: size, content_type: "application/zip",
    visibility: "private", part_size_bytes: size <= PART ? size : PART, part_count: partCount, expires_at: "x",
  });
  const urlsFor = (nums: number[]) => nums.map((n) => ({ part_number: n, url: `https://s3.test/part/${n}`, byte_start: 0, byte_end: 0 }));
  let verifyPolls = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url: string, init: { method: string; body?: Blob | string; headers?: Record<string, string> }) => {
    if (url.startsWith("https://s3.test/part/")) {
      const n = Number(url.split("/").pop());
      w.puts++;
      if (w.stopAfterParts >= 0 && w.parts.size >= w.stopAfterParts) throw new TypeError("Load failed (page reloaded)");
      if (w.dropEvery && w.puts % w.dropEvery === 0) throw new TypeError("Network connection was lost");
      if (w.expireFirst.has(n)) { w.expireFirst.delete(n); return new Response("<Error>Request has expired</Error>", { status: 403 }); }
      const body = init.body as Blob;
      const expected = Math.min(PART, size - (n - 1) * PART);
      assert.equal(body.size, expected, `part ${n} length`);
      if (mode === "single") assert.equal(init.headers?.["content-type"], "application/zip");
      w.parts.set(n, body.size);
      return new Response(null, { status: 200, headers: { etag: `"e${n}"` } });
    }
    const path = url.replace("https://app.example", "");
    w.apiCalls.push(`${init.method} ${path}`);
    const all = Array.from({ length: partCount }, (_, i) => i + 1);
    if (init.method === "POST" && path === "/api/uploads") return json({ ...base(), parts: urlsFor(all.slice(0, 64)) }, 201);
    if (init.method === "GET" && path === `/api/uploads/${ID}`) {
      if (w.status === "verifying" && ++verifyPolls >= 2) w.status = "completed";
      const done = [...w.parts.keys()].sort((a, b) => a - b);
      return json({ ...base(), parts_done: done, ...(w.status === "completed" ? { asset: { key: "k", size_bytes: size } } : {}) });
    }
    if (init.method === "POST" && path === `/api/uploads/${ID}/urls`) {
      const body = JSON.parse(String(init.body)) as { part_numbers: number[] };
      return json({ ...base(), parts: urlsFor(body.part_numbers) });
    }
    if (init.method === "POST" && path === `/api/uploads/${ID}/complete`) {
      assert.equal(w.parts.size, partCount, "completed only after every part");
      w.status = mode === "single" ? "completed" : "verifying";
      return json({ ...base(), ...(w.status === "completed" ? { asset: { key: "k", size_bytes: size } } : {}) }, w.status === "verifying" ? 202 : 200);
    }
    throw new Error(`unexpected ${init.method} ${path}`);
  };
  return { fetch, indexedDB: idb, navigator: { onLine: true } };
}

function world(over: Partial<World> = {}): World {
  return { parts: new Map(), puts: 0, apiCalls: [], dropEvery: 0, expireFirst: new Set(), status: "active", stopAfterParts: -1, ...over };
}

const fast = { endpoint: "https://app.example/api/uploads", retryBaseMs: 1, pollMs: 1 };

describe("browser/upload.js uploadFile", () => {
  it("uploads a 100-part file 4 at a time, renewing URLs past the first batch, and resolves to the asset", async () => {
    const size = 100 * PART - 123;
    const w = world();
    const progress: number[] = [];
    const asset = await uploadFile(fakeFile(size), { ...fast, env: env(size, w), onProgress: (p: { fraction: number }) => progress.push(p.fraction) });
    assert.deepEqual(asset, { key: "k", size_bytes: size });
    assert.equal(w.parts.size, 100);
    assert.equal(w.puts, 100);
    assert.ok(w.apiCalls.some((c) => c.endsWith("/urls")), "fetched URLs for parts 65..100");
    assert.equal(progress.at(-1), 1);
  });

  it("survives dropped connections and expired URLs without resending a part that landed", async () => {
    const size = 20 * PART;
    const w = world({ dropEvery: 3, expireFirst: new Set([5, 9]) });
    await uploadFile(fakeFile(size), { ...fast, env: env(size, w) });
    assert.equal(w.parts.size, 20);
    assert.ok(w.puts > 20, "retried the dropped and expired parts");
  });

  it("sends a small file as one PUT with its content type, completed inline", async () => {
    const w = world();
    const asset = await uploadFile(fakeFile(1000), { ...fast, env: env(1000, w) });
    assert.deepEqual(asset, { key: "k", size_bytes: 1000 });
    assert.equal(w.puts, 1);
  });

  it("resumes after a reload when the same file is picked again, sending only what storage lacks", async () => {
    const size = 10 * PART;
    const idb = fakeIndexedDb();
    const w = world({ stopAfterParts: 6 });
    await assert.rejects(uploadFile(fakeFile(size), { ...fast, env: env(size, w, idb), concurrency: 1, retryBaseMs: 0 }));
    assert.equal(w.parts.size, 6);
    assert.equal(idb.data.size, 1, "the upload is remembered");

    // The page reloads; the member picks the same file.
    w.stopAfterParts = -1;
    const putsBefore = w.puts;
    await uploadFile(fakeFile(size), { ...fast, env: env(size, w, idb) });
    assert.equal(w.parts.size, 10);
    assert.equal(w.puts - putsBefore, 4, "only the four missing parts were sent");
    assert.equal(w.apiCalls.filter((c) => c === "POST /api/uploads").length, 1, "no second upload was opened");
    assert.equal(idb.data.size, 0, "forgotten once complete");
  });

  it("rejects with the server's code", async () => {
    const e = env(1000, world());
    const refused = { ...e, fetch: async () => new Response(JSON.stringify({ code: "QUOTA_EXCEEDED", message: "over" }), { status: 403 }) };
    await assert.rejects(uploadFile(fakeFile(1000), { ...fast, env: refused }), (err: { code: string; status: number }) =>
      err.code === "QUOTA_EXCEEDED" && err.status === 403);
  });
});
