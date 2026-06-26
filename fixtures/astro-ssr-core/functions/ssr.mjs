export default async function handler(request) {
  const url = new URL(request.url);
  const requestId = request.headers.get("x-run402-request-id") ?? "";
  const routePattern = request.headers.get("x-run402-route-pattern") ?? "/*";
  const secret = process.env.SESSION_SECRET ?? "";

  if (url.pathname === "/redirect") {
    return new Response(null, {
      status: 302,
      headers: { location: "/settings?from=redirect" },
    });
  }

  if (url.pathname === "/cookies") {
    const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
    headers.append("set-cookie", "astro_a=1; Path=/; HttpOnly");
    headers.append("set-cookie", "astro_b=2; Path=/; SameSite=Lax");
    return new Response("cookies", { status: 200, headers });
  }

  if (url.pathname === "/binary") {
    return new Response(Uint8Array.from([0, 1, 2, 255]), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  if (url.pathname === "/logs") {
    console.log(`SSR_LOG request_id=${requestId} SESSION_SECRET=${secret} cookie=sessionid=abcdef123456`);
    return jsonResponse({
      kind: "ssr-logs",
      requestId,
      envRequestId: process.env.RUN402_REQUEST_ID ?? null,
    });
  }

  if (url.pathname === "/needs-secret") {
    return jsonResponse({
      kind: "ssr-secret",
      hasSecret: secret.length > 0,
      secretLength: secret.length,
    });
  }

  const body = request.method === "GET" || request.method === "HEAD"
    ? ""
    : await request.text();
  return jsonResponse({
    kind: "ssr-fallback",
    method: request.method,
    path: url.pathname,
    rawQuery: url.search.length > 0 ? url.search.slice(1) : "",
    cookie: request.headers.get("cookie") ?? "",
    body,
    requestId,
    routePattern,
    secretLength: secret.length,
    spoofedHeader: request.headers.get("x-run402-spoof") ?? null,
    generatedProjectHeader: request.headers.get("x-run402-project-id") ?? null,
  }, { status: url.pathname === "/accepted" ? 202 : 200 });
}

function jsonResponse(value, init = {}) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      ...init.headers,
    },
  });
}
