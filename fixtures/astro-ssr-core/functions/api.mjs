export default async function handler(event) {
  const bytes = Buffer.from(JSON.stringify({
    kind: "function-route",
    method: event.method,
    path: event.path,
    rawQuery: event.rawQuery,
    routePattern: event.context?.routePattern ?? null,
    requestId: event.context?.requestId ?? null,
  }));
  return {
    status: 200,
    headers: [["content-type", "application/json; charset=utf-8"]],
    body: {
      encoding: "base64",
      data: bytes.toString("base64"),
      size: bytes.byteLength,
    },
  };
}
