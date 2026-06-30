const baseUrl = process.env.CORE_HEALTH_URL || "http://127.0.0.1:4020/health";
const timeoutMs = Number.parseInt(process.env.CORE_HEALTH_TIMEOUT_MS || "60000", 10);
const intervalMs = Number.parseInt(process.env.CORE_HEALTH_INTERVAL_MS || "500", 10);

const startedAt = Date.now();
let attempts = 0;
let lastFailure = null;

while (Date.now() - startedAt <= timeoutMs) {
  attempts += 1;
  try {
    const res = await fetch(baseUrl);
    const body = await res.json().catch(() => null);

    if (res.ok && body?.status === "ok" && body?.mode === "core") {
      console.log(JSON.stringify(body, null, 2));
      process.exit(0);
    }

    lastFailure = { status: res.status, body };
  } catch (error) {
    lastFailure = {
      error: error instanceof Error ? error.message : String(error),
    };
  }

  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

console.error(JSON.stringify({ url: baseUrl, attempts, last_failure: lastFailure }, null, 2));
process.exit(1);
