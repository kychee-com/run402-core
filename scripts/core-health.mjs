const baseUrl = process.env.CORE_HEALTH_URL || "http://127.0.0.1:4020/health";

const res = await fetch(baseUrl);
const body = await res.json().catch(() => null);

if (!res.ok || body?.status !== "ok" || body?.mode !== "core") {
  console.error(JSON.stringify({ status: res.status, body }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(body, null, 2));
