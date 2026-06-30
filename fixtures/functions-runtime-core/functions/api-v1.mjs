import { auth } from "@run402/functions";

const VERSION = "v1";
const RESPONSE_LIMIT_BYTES = 6 * 1024 * 1024;

export default async function handler(event) {
  console.log(`functions-runtime fixture ${VERSION} ${event.requestId}`);
  if (event.invocationKind === "direct" || !event.version) {
    return jsonResponse({
      kind: event.invocationKind,
      requestId: event.requestId,
      version: VERSION,
    });
  }

  const url = new URL(event.url);
  switch (event.path) {
    case "/functions/v1/api": {
      const body = await event.json();
      return jsonResponse({
        version: VERSION,
        trigger: event.headers.get("x-run402-trigger"),
        bodyTrigger: body.trigger,
        scheduledAt: body.scheduled_at,
      });
    }
    case "/api/json":
      return jsonResponse({
        version: VERSION,
        method: event.method,
        path: event.path,
        rawQuery: event.rawQuery,
        requestId: event.context.requestId,
        cookie: event.cookies.raw,
        body: routedBodyText(event),
        headers: headerList(event.headers),
        routePattern: event.context.routePattern,
        locale: event.context.locale,
        defaultLocale: event.context.defaultLocale,
      }, 203);
    case "/api/logs":
      console.log(`fixture log Authorization: Bearer abcdef123456 cookie=sessionid API_TOKEN=${process.env.API_TOKEN ?? ""}`);
      console.error("fixture payment x-run402-payment: paytoken api_key=abcd1234abcd1234");
      return jsonResponse({ logged: true, requestId: event.context.requestId, version: VERSION });
    case "/api/throw":
      throw new Error(`fixture uncaught raw ${process.env.API_TOKEN ?? ""}`);
    case "/api/binary":
      return bytesResponse(Buffer.from([0, 1, 2, 255]), "application/octet-stream");
    case "/api/cookies":
      return {
        status: 302,
        headers: [["location", "/next"]],
        cookies: ["a=1; Path=/", "b=2; Path=/"],
        body: null,
      };
    case "/api/cors":
      return jsonResponse({ cors: true }, 200, [["access-control-allow-origin", "https://allowed.example"]]);
    case "/api/large":
      return bytesResponse(Buffer.alloc(RESPONSE_LIMIT_BYTES + 1, "x"), "text/plain");
    case "/api/sleep":
      await sleep(Math.min(Number(url.searchParams.get("ms") ?? "100"), 2_000));
      return jsonResponse({ slept: true, version: VERSION });
    case "/api/slow":
      await sleep(11_000);
      return jsonResponse({ tooSlow: true });
    case "/api/version":
      return jsonResponse({ version: VERSION });
    case "/auth/user": {
      const user = await auth.user();
      return jsonResponse({
        authenticated: Boolean(user),
        userId: user?.id ?? null,
        headerUserId: headerValue(event.headers, "x-run402-user-id"),
        role: await auth.role(),
      });
    }
    case "/admin/role":
      return jsonResponse({
        role: await auth.role(),
        headerRole: headerValue(event.headers, "x-run402-user-role"),
      });
    case "/secret/value":
      return jsonResponse({
        hasSecret: process.env.API_TOKEN === "core-secret-value",
        secretLength: process.env.API_TOKEN?.length ?? 0,
      });
    default:
      return jsonResponse({ path: event.path, version: VERSION });
  }
}

function jsonResponse(value, status = 200, headers = []) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return {
    status,
    headers: [["content-type", "application/json; charset=utf-8"], ...headers],
    body: {
      encoding: "base64",
      data: bytes.toString("base64"),
      size: bytes.byteLength,
    },
  };
}

function bytesResponse(bytes, contentType) {
  return {
    status: 200,
    headers: [["content-type", contentType]],
    body: {
      encoding: "base64",
      data: bytes.toString("base64"),
      size: bytes.byteLength,
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headerValue(headers, name) {
  if (typeof headers.get === "function") return headers.get(name);
  const found = headers.find(([candidate]) => candidate.toLowerCase() === name.toLowerCase());
  return found?.[1] ?? null;
}

function headerList(headers) {
  if (typeof headers.entries === "function") return Array.from(headers.entries());
  return headers;
}

function routedBodyText(event) {
  const body = event.routedBody ?? event.body;
  return body ? Buffer.from(body.data, "base64").toString("utf8") : null;
}
