/*
 * Run402 web push — the service worker half. Served at /_run402/push-sw.js on
 * every app host. `Run402Push.subscribe()` registers it at scope "/" when the
 * app has no worker of its own; an app that has one adds a single line to it:
 *
 *   importScripts("/_run402/push-sw.js");
 *
 * Messages arrive in the Declarative Web Push shape:
 *
 *   { "web_push": 8030, "notification": { "title", "body", "tag", "navigate", ... } }
 *
 * A browser that understands that shape (WebKit) shows the notification
 * itself and hands this worker its proposal as `event.notification`; every
 * other browser gets the JSON and this worker shows it. A click opens
 * `navigate`. Any other payload is left to the app's own handlers.
 *
 * Plain ES2018, no modules, no dependencies: it is served as-is.
 */
(function () {
  "use strict";

  var WORKER_PATH = "/_run402/push-sw.js";

  function declarativeNotification(event) {
    if (!event.data) return null;
    var payload;
    try {
      payload = event.data.json();
    } catch (err) {
      return null;
    }
    if (!payload || payload.web_push !== 8030) return null;
    var notification = payload.notification;
    if (!notification || typeof notification.title !== "string" || notification.title === "") return null;
    return notification;
  }

  self.addEventListener("push", function (event) {
    // The browser already shows its own notification for this message.
    if (event.notification) return;
    var notification = declarativeNotification(event);
    if (!notification) return;
    var options = { silent: notification.silent === true, data: { navigate: notification.navigate } };
    ["body", "tag", "lang", "dir"].forEach(function (name) {
      if (notification[name] !== undefined) options[name] = notification[name];
    });
    event.waitUntil(self.registration.showNotification(notification.title, options));
  });

  async function openNavigate(navigate) {
    var target = new URL(navigate, self.location.origin);
    var windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    var i;
    for (i = 0; i < windows.length; i++) {
      if (windows[i].url === target.href && "focus" in windows[i]) return windows[i].focus();
    }
    if (target.origin === self.location.origin) {
      for (i = 0; i < windows.length; i++) {
        var client = windows[i];
        if (new URL(client.url).origin !== self.location.origin || !("navigate" in client)) continue;
        try {
          await client.focus();
          var navigated = await client.navigate(target.href);
          if (navigated) return navigated;
        } catch (err) {
          // A window this worker does not control cannot be navigated; open one.
        }
        break;
      }
    }
    return self.clients.openWindow(target.href);
  }

  self.addEventListener("notificationclick", function (event) {
    var data = event.notification && event.notification.data;
    if (!data || !data.navigate) return;
    event.notification.close();
    event.waitUntil(openNavigate(data.navigate));
  });

  // `Run402Push.subscribe()` pings an app's own worker to learn whether this
  // file is imported into it.
  self.addEventListener("message", function (event) {
    if (!event.data || event.data.type !== "run402-push-ping") return;
    var port = event.ports && event.ports[0];
    if (port) port.postMessage({ type: "run402-push-pong" });
  });

  // Only when registered as the worker itself; imported into an app's worker,
  // the app owns its own lifecycle.
  if (self.location.pathname === WORKER_PATH) {
    self.addEventListener("install", function () {
      self.skipWaiting();
    });
    self.addEventListener("activate", function (event) {
      event.waitUntil(self.clients.claim());
    });
  }
})();
