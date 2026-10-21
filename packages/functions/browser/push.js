/*
 * Run402 web push — the browser half. Served at /_run402/push.js on every app
 * host (the app's own origin), so a page includes it with
 *
 *   <script src="/_run402/push.js"></script>
 *
 * and gets `window.Run402Push = { subscribe, unsubscribe, status }`:
 *
 *   - `status()` resolves "unsupported" | "needs_install" | "default" |
 *     "denied" | "subscribed" without prompting.
 *   - `subscribe({ accessToken })` asks for permission when it has not been
 *     decided (call it from a tap the first time; iPhone only prompts from a
 *     tap), subscribes this browser and records the subscription for the
 *     signed-in user. Called again at start-up it never prompts and
 *     re-confirms with the server at most once a day; called from a tap it
 *     always re-confirms.
 *   - `unsubscribe({ accessToken })` removes this browser's subscription.
 *
 * Failures reject with an Error whose `.code` says what to do next:
 * "unsupported", "needs_install", "permission_denied", "needs_user_gesture",
 * "worker_missing_snippet" (with `.fix`), "sign_in_required", or the
 * server's own code (with `.status` and `.next_actions`).
 *
 * Plain ES2018, no modules, no dependencies: it is served as-is.
 */
(function () {
  "use strict";

  var WORKER_PATH = "/_run402/push-sw.js";
  var KEY_PATH = "/_run402/push/key";
  var SUBSCRIPTIONS_PATH = "/_run402/push/subscriptions";
  var STORAGE_KEY = "run402.push.confirmed";
  var RECONFIRM_MS = 24 * 60 * 60 * 1000;
  var PING_TIMEOUT_MS = 1000;
  var WORKER_FIX = 'importScripts("/_run402/push-sw.js");';

  function fail(code, message, extra) {
    var err = new Error(message);
    err.code = code;
    if (extra) Object.assign(err, extra);
    return err;
  }

  // ---- What this browser can do --------------------------------------------

  function isIOS() {
    var ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/.test(ua)) return true;
    // iPadOS reports itself as a Mac; a touch screen gives it away.
    return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  }

  function isStandalone() {
    if (navigator.standalone === true) return true;
    return typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  }

  // Web push on iPhone and iPad only works from the Home Screen app.
  function needsInstall() {
    return isIOS() && !isStandalone();
  }

  function isSupported() {
    if (typeof window.Notification === "undefined") return false;
    // `window.pushManager` is WebKit's Declarative Web Push, which needs no worker.
    if (window.pushManager) return true;
    return "serviceWorker" in navigator && "PushManager" in window;
  }

  // ---- Service worker -------------------------------------------------------

  function scriptPath(registration) {
    var worker = registration.active || registration.waiting || registration.installing;
    return worker ? new URL(worker.scriptURL, window.location.href).pathname : "";
  }

  function rootRegistration() {
    if (!navigator.serviceWorker) return Promise.resolve(null);
    return navigator.serviceWorker.getRegistration("/").then(function (registration) {
      return registration || null;
    });
  }

  // Does the app's own worker carry `importScripts("/_run402/push-sw.js")`?
  // The imported snippet answers a ping; anything else stays silent.
  function answersPing(registration) {
    var worker = registration.active || registration.waiting || registration.installing;
    if (!worker) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var channel = new MessageChannel();
      var timer = setTimeout(function () {
        finish(false);
      }, PING_TIMEOUT_MS);
      function finish(answered) {
        clearTimeout(timer);
        channel.port1.onmessage = null;
        channel.port1.close();
        resolve(answered);
      }
      channel.port1.onmessage = function (event) {
        if (event.data && event.data.type === "run402-push-pong") finish(true);
      };
      worker.postMessage({ type: "run402-push-ping" }, [channel.port2]);
    });
  }

  // The registration this helper may use. Never registers over an app's own
  // worker: one without the snippet is refused with the line to add.
  async function usableRegistration(existing) {
    if (scriptPath(existing) === WORKER_PATH) return existing;
    if (await answersPing(existing)) return existing;
    throw fail(
      "worker_missing_snippet",
      "This app has its own service worker without the Run402 push snippet. Add " + WORKER_FIX + " to it.",
      { fix: WORKER_FIX },
    );
  }

  function whenActive(registration) {
    if (registration.active) return Promise.resolve(registration);
    var worker = registration.installing || registration.waiting;
    if (!worker) return navigator.serviceWorker.ready.then(function () { return registration; });
    return new Promise(function (resolve, reject) {
      worker.addEventListener("statechange", function onChange() {
        if (worker.state === "activated") {
          worker.removeEventListener("statechange", onChange);
          resolve(registration);
        } else if (worker.state === "redundant") {
          worker.removeEventListener("statechange", onChange);
          reject(fail("worker_failed", "The Run402 push service worker failed to install."));
        }
      });
    });
  }

  // ---- Subscription ---------------------------------------------------------

  async function currentSubscription() {
    if (window.pushManager) return window.pushManager.getSubscription();
    var registration = await rootRegistration();
    return registration ? registration.pushManager.getSubscription() : null;
  }

  function base64urlToBytes(value) {
    var base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64url(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function sameKey(subscription, key) {
    var current = subscription.options && subscription.options.applicationServerKey;
    if (!current) return true; // the browser does not say; keep the subscription
    var bytes = new Uint8Array(current);
    if (bytes.length !== key.length) return false;
    for (var i = 0; i < key.length; i++) if (bytes[i] !== key[i]) return false;
    return true;
  }

  // "psub_" + base64url(SHA-256(endpoint)): the id the server gives the same endpoint.
  async function subscriptionId(endpoint) {
    var digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
    return "psub_" + bytesToBase64url(new Uint8Array(digest));
  }

  // ---- Server calls ---------------------------------------------------------

  function authHeaders(accessToken, json) {
    var headers = {};
    if (json) headers["Content-Type"] = "application/json";
    if (accessToken) headers.Authorization = "Bearer " + accessToken;
    return headers;
  }

  async function readJson(res) {
    try {
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  function serverError(res, body, fallbackCode) {
    var envelope = body && typeof body === "object" ? body : {};
    var code = res.status === 401 ? "sign_in_required" : envelope.code || envelope.error || fallbackCode;
    return fail(code, envelope.message || "Run402 push request failed (" + res.status + ").", {
      status: res.status,
      next_actions: Array.isArray(envelope.next_actions) ? envelope.next_actions : [],
    });
  }

  async function fetchKey() {
    var res = await fetch(KEY_PATH, { credentials: "same-origin" });
    var body = await readJson(res);
    if (!res.ok || !body || typeof body.vapid_public_key !== "string") {
      throw serverError(res, body, "key_unavailable");
    }
    return base64urlToBytes(body.vapid_public_key);
  }

  // ---- Re-confirmation throttle (storage can throw; it is only a hint) ------

  function readConfirmed() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function writeConfirmed(endpoint, userId) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ endpoint: endpoint, user_id: userId || null, at: Date.now() }));
    } catch (err) {
      // No storage: the next start-up simply confirms again.
    }
  }

  function clearConfirmed() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      // Nothing to clear.
    }
  }

  // The signed-in user a Bearer token names, when the app passed one.
  function tokenSubject(accessToken) {
    if (!accessToken) return null;
    try {
      var payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(accessToken.split(".")[1] || "")));
      return typeof payload.sub === "string" ? payload.sub : null;
    } catch (err) {
      return null;
    }
  }

  // A record for this endpoint from the last day, made for the same user when
  // the token says who that is (another sign-in on this phone re-confirms).
  function recentlyConfirmed(endpoint, accessToken) {
    var record = readConfirmed();
    var subject = tokenSubject(accessToken);
    return Boolean(
      record &&
        record.endpoint === endpoint &&
        typeof record.at === "number" &&
        Date.now() - record.at < RECONFIRM_MS &&
        (subject === null || record.user_id === subject),
    );
  }

  // ---- Public API -----------------------------------------------------------

  async function status() {
    if (needsInstall()) return "needs_install";
    if (!isSupported()) return "unsupported";
    var permission = window.Notification.permission;
    if (permission === "denied") return "denied";
    if (permission !== "granted") return "default";
    return (await currentSubscription()) ? "subscribed" : "default";
  }

  async function subscribe(options) {
    var accessToken = options && options.accessToken;
    if (needsInstall()) {
      throw fail("needs_install", "On iPhone and iPad, notifications work only from the Home Screen app: Share, then Add to Home Screen.");
    }
    if (!isSupported()) throw fail("unsupported", "This browser does not support web push notifications.");
    var Notification = window.Notification;
    var grantedAtStart = Notification.permission === "granted";
    // A tap or click always re-confirms; only a start-up call takes the daily
    // skip. Read it now: the activation is spent by the awaits below.
    var fromGesture = Boolean(navigator.userActivation && navigator.userActivation.isActive);
    if (Notification.permission === "denied") {
      throw fail("permission_denied", "Notifications are blocked for this site in the browser's settings.");
    }

    // Ask before anything else is awaited: iPhone shows the prompt only while
    // the tap that called subscribe() still counts, and every await spends it.
    var permission = Notification.permission;
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch (err) {
        permission = Notification.permission;
      }
    }
    if (permission === "denied") throw fail("permission_denied", "The notification permission was denied.");
    if (permission !== "granted") {
      throw fail("needs_user_gesture", "Call Run402Push.subscribe() from a tap or click so the browser can ask for permission.");
    }

    var registration = await rootRegistration();
    if (registration) registration = await usableRegistration(registration);

    if (navigator.serviceWorker) {
      if (!registration) registration = await navigator.serviceWorker.register(WORKER_PATH, { scope: "/" });
      registration = await whenActive(registration);
    }
    var pushManager = window.pushManager || registration.pushManager;

    var key = await fetchKey();
    var subscription = await pushManager.getSubscription();
    if (subscription && !sameKey(subscription, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!subscription) {
      subscription = await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }

    var id = await subscriptionId(subscription.endpoint);
    if (grantedAtStart && !fromGesture && recentlyConfirmed(subscription.endpoint, accessToken)) {
      return { status: "subscribed", subscription_id: id, confirmed: false };
    }

    var json = subscription.toJSON();
    var res = await fetch(SUBSCRIPTIONS_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: authHeaders(accessToken, true),
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys && json.keys.p256dh, auth: json.keys && json.keys.auth },
        expiration_time: json.expirationTime == null ? null : json.expirationTime,
      }),
    });
    var body = await readJson(res);
    if (!res.ok) throw serverError(res, body, "subscribe_failed");
    writeConfirmed(subscription.endpoint, body && body.user_id);
    return Object.assign({}, body, { confirmed: true });
  }

  async function unsubscribe(options) {
    var accessToken = options && options.accessToken;
    var subscription = isSupported() ? await currentSubscription() : null;
    if (!subscription) {
      clearConfirmed();
      return { status: "not_subscribed" };
    }
    var id = await subscriptionId(subscription.endpoint);
    var res = await fetch(SUBSCRIPTIONS_PATH + "/" + encodeURIComponent(id), {
      method: "DELETE",
      credentials: "same-origin",
      headers: authHeaders(accessToken, false),
    });
    // The phone stops receiving either way; a server row left behind is
    // removed the next time a send finds the subscription gone.
    var failure = res.ok || res.status === 404 ? null : serverError(res, await readJson(res), "unsubscribe_failed");
    await subscription.unsubscribe();
    clearConfirmed();
    if (failure) throw failure;
    return { status: "unsubscribed", subscription_id: id };
  }

  window.Run402Push = { subscribe: subscribe, unsubscribe: unsubscribe, status: status };
})();
