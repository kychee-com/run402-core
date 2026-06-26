const VERSION = "v2";

export default async function handler(event) {
  if (event.invocationKind === "direct" || !event.version) {
    return jsonResponse({
      kind: event.invocationKind,
      requestId: event.requestId,
      version: VERSION,
    });
  }
  return jsonResponse({
    version: VERSION,
    method: event.method,
    path: event.path,
    requestId: event.context.requestId,
  });
}

function jsonResponse(value, status = 200) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return {
    status,
    headers: [["content-type", "application/json; charset=utf-8"]],
    body: {
      encoding: "base64",
      data: bytes.toString("base64"),
      size: bytes.byteLength,
    },
  };
}
