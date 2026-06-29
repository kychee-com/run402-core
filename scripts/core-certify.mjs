#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const CERTIFICATION_VERSION = "run402.core_certification.v1";

const DEFAULT_TIMEOUT_MS = 10_000;
const BODY_SAMPLE_LIMIT = 2048;

export async function runCertification(config, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Core certification requires fetch.");
  }
  const startedAt = new Date().toISOString();
  const context = normalizeConfig(config);
  const probes = [];

  await runProbe(probes, context, "health", () => probeHealth(context, fetchImpl));
  await runProbe(probes, context, "project-metadata", () => probeProjectMetadata(context, fetchImpl));

  if (context.probes.static) {
    await runProbe(probes, context, "static-fetch", () => probeHttp(context, fetchImpl, "static-fetch", context.probes.static));
  }
  if (context.probes.runtime_config) {
    await runProbe(probes, context, "runtime-config", () => probeHttp(context, fetchImpl, "runtime-config", context.probes.runtime_config));
  }
  if (context.probes.function) {
    await runProbe(probes, context, "routed-function", () => probeHttp(context, fetchImpl, "routed-function", context.probes.function, {
      expectRequestIdHeader: true,
    }));
  }
  if (context.probes.ssr) {
    await runProbe(probes, context, "ssr-fallback", () => probeHttp(context, fetchImpl, "ssr-fallback", context.probes.ssr, {
      classifySsrStub: true,
    }));
  }
  if (context.probes.rls) {
    await runProbe(probes, context, "postgrest-rls", () => probePostgrestRls(context, fetchImpl, context.probes.rls));
  }

  const finishedAt = new Date().toISOString();
  const blockers = probes
    .flatMap((probe) => probe.blocker ? [{ probe: probe.name, ...probe.blocker }] : []);
  const evidence = {
    version: CERTIFICATION_VERSION,
    status: blockers.length === 0 && probes.every((probe) => probe.status === "pass") ? "pass" : "fail",
    started_at: startedAt,
    finished_at: finishedAt,
    target: {
      base_url: context.baseUrl,
      project_id: context.projectId,
    },
    summary: {
      passed: probes.filter((probe) => probe.status === "pass").length,
      failed: probes.filter((probe) => probe.status === "fail").length,
      skipped: probes.filter((probe) => probe.status === "skip").length,
      blockers: blockers.length,
    },
    probes,
    blockers,
  };
  return redactEvidence(evidence, context.redactionValues);
}

export async function probeHealth(context, fetchImpl) {
  const response = await requestJson(context, fetchImpl, "GET", "/health");
  if (response.status !== 200) {
    return failedHttpProbe("health", response, "core_runtime_capability_gap", "Core health endpoint did not return HTTP 200.");
  }
  const body = response.json && typeof response.json === "object" ? response.json : {};
  if (body.status !== "ok") {
    return {
      status: "fail",
      response,
      blocker: {
        kind: "core_runtime_capability_gap",
        owner: "run402-core",
        message: "Core health endpoint did not report status=ok.",
      },
    };
  }
  return { status: "pass", response };
}

export async function probeProjectMetadata(context, fetchImpl) {
  const response = await requestJson(context, fetchImpl, "GET", `/projects/v1/${context.projectId}`, {
    headers: serviceHeaders(context),
  });
  if (response.status !== 200) {
    return failedHttpProbe("project-metadata", response, classifyHttpBlocker(response, "project-metadata"), "Project metadata read failed.");
  }
  return { status: "pass", response };
}

export async function probeHttp(context, fetchImpl, name, probe, options = {}) {
  const method = probe.method ?? "GET";
  const response = await requestText(context, fetchImpl, method, probe.path, {
    body: probe.body,
    headers: probe.headers,
  });
  const expectedStatus = probe.expect_status ?? 200;
  if (response.status !== expectedStatus) {
    return failedHttpProbe(name, response, classifyHttpBlocker(response, name), `Expected HTTP ${expectedStatus}, got ${response.status}.`);
  }
  if (probe.expect_text && !response.body_sample.includes(probe.expect_text)) {
    return {
      status: "fail",
      response,
      blocker: {
        kind: "app_source_deploy_mapping",
        owner: "app",
        message: `Response body did not include expected text for ${name}.`,
      },
    };
  }
  if (options.expectRequestIdHeader && !/^req_/.test(response.headers["x-run402-request-id"] ?? "")) {
    return {
      status: "fail",
      response,
      blocker: {
        kind: "core_runtime_capability_gap",
        owner: "run402-core",
        message: `${name} did not expose an X-Run402-Request-Id header.`,
      },
    };
  }
  if (options.classifySsrStub && looksLikeSsrStub(response)) {
    return {
      status: "fail",
      response,
      blocker: {
        kind: "core_runtime_capability_gap",
        owner: "run402-core",
        message: "SSR probe returned a stub/unavailable response instead of a live fallback.",
      },
    };
  }
  return { status: "pass", response };
}

export async function probePostgrestRls(context, fetchImpl, probe) {
  const postgrestBase = probe.postgrest_url ?? context.postgrestUrl;
  if (!postgrestBase) {
    return {
      status: "fail",
      blocker: {
        kind: "docs_friction",
        owner: "app",
        message: "PostgREST/RLS probe requires postgrest_url in config or probe.",
      },
    };
  }
  const anon = await requestAbsoluteJson(fetchImpl, `${stripSlash(postgrestBase)}/${stripLeadingSlash(probe.path)}`);
  const anonCount = Array.isArray(anon.json) ? anon.json.length : null;
  if (probe.anon_expect_count !== undefined && anonCount !== probe.anon_expect_count) {
    return {
      status: "fail",
      response: anon,
      blocker: {
        kind: "core_runtime_capability_gap",
        owner: "run402-core",
        message: `Anon RLS row count was ${anonCount}, expected ${probe.anon_expect_count}.`,
      },
    };
  }
  if (!probe.user) {
    return { status: "pass", response: { anon } };
  }
  const token = await requestJson(context, fetchImpl, "POST", "/auth/v1/dev-tokens", {
    body: {
      project_id: context.projectId,
      role: probe.user.role ?? "authenticated",
      sub: probe.user.sub,
    },
  });
  if (token.status !== 200 || !token.json?.authorization) {
    return failedHttpProbe("postgrest-rls-dev-token", token, "core_runtime_capability_gap", "Could not mint Core dev-token for RLS probe.");
  }
  const user = await requestAbsoluteJson(fetchImpl, `${stripSlash(postgrestBase)}/${stripLeadingSlash(probe.path)}`, {
    headers: { authorization: token.json.authorization },
  });
  const userCount = Array.isArray(user.json) ? user.json.length : null;
  if (probe.user.expect_count !== undefined && userCount !== probe.user.expect_count) {
    return {
      status: "fail",
      response: { anon, user },
      blocker: {
        kind: "core_runtime_capability_gap",
        owner: "run402-core",
        message: `Authenticated RLS row count was ${userCount}, expected ${probe.user.expect_count}.`,
      },
    };
  }
  return { status: "pass", response: { anon, user } };
}

export function classifyHttpBlocker(response, probeName = "probe") {
  const text = `${response.body_sample ?? ""} ${JSON.stringify(response.json ?? {})}`.toLowerCase();
  if (
    response.status === 501 ||
    response.status === 503 ||
    text.includes("dynamic_runtime_unavailable") ||
    text.includes("runtime_kernel_unavailable") ||
    text.includes("postgrest_unavailable") ||
    text.includes("unsupported")
  ) {
    return "core_runtime_capability_gap";
  }
  if (response.status === 404) {
    return probeName === "health" ? "core_runtime_capability_gap" : "app_source_deploy_mapping";
  }
  if (response.status === 400 && (text.includes("cloud-only") || text.includes("not part of core"))) {
    return "intentionally_unsupported_cloud_only_feature";
  }
  if (response.status === 400 && text.includes("manifest")) {
    return "public_sdk_cli_package_gap";
  }
  return "docs_friction";
}

export function redactEvidence(value, explicitSecrets = []) {
  const secrets = explicitSecrets
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .sort((a, b) => b.length - a.length);
  return redactValue(value, secrets);
}

export function normalizeConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Certification config must be a JSON object.");
  }
  const baseUrl = requireString(config.base_url ?? config.baseUrl, "base_url");
  const projectId = requireString(config.project_id ?? config.projectId, "project_id");
  const serviceKey = typeof config.service_key === "string" ? config.service_key : undefined;
  const redactionValues = [
    serviceKey,
    ...(Array.isArray(config.redact_values) ? config.redact_values : []),
  ].filter(Boolean);
  return {
    baseUrl: stripSlash(baseUrl),
    projectId,
    serviceKey,
    postgrestUrl: typeof config.postgrest_url === "string" ? config.postgrest_url : undefined,
    redactionValues,
    probes: {
      ...(isObject(config.probes) ? config.probes : {}),
    },
  };
}

async function runProbe(probes, context, name, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    probes.push({
      name,
      status: result.status,
      duration_ms: Date.now() - started,
      ...(result.response ? { response: redactEvidence(result.response, context.redactionValues) } : {}),
      ...(result.blocker ? { blocker: result.blocker } : {}),
    });
  } catch (err) {
    probes.push({
      name,
      status: "fail",
      duration_ms: Date.now() - started,
      error: redactEvidence(errorEvidence(err), context.redactionValues),
      blocker: {
        kind: "docs_friction",
        owner: "app",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

function failedHttpProbe(name, response, kind, message) {
  return {
    status: "fail",
    response,
    blocker: {
      kind,
      owner: kind === "app_source_deploy_mapping" || kind === "docs_friction" ? "app" : "run402-core",
      message,
    },
  };
}

async function requestJson(context, fetchImpl, method, path, options = {}) {
  return requestAbsoluteJson(fetchImpl, urlFor(context, path), {
    method,
    headers: options.headers,
    body: options.body,
  });
}

async function requestText(context, fetchImpl, method, path, options = {}) {
  return requestAbsoluteText(fetchImpl, urlFor(context, path), {
    method,
    headers: options.headers,
    body: options.body,
  });
}

async function requestAbsoluteJson(fetchImpl, url, options = {}) {
  const response = await requestAbsoluteText(fetchImpl, url, options);
  const contentType = response.headers["content-type"] ?? "";
  if (!contentType.includes("json") && response.body_sample.trim() === "") {
    return { ...response, json: null };
  }
  try {
    return { ...response, json: JSON.parse(response.body_sample) };
  } catch {
    return { ...response, json: null };
  }
}

async function requestAbsoluteText(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const headers = {
      ...(options.body && typeof options.body === "object" ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    };
    const response = await fetchImpl(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      url,
      headers: headersToObject(response.headers),
      body_sample: body.slice(0, BODY_SAMPLE_LIMIT),
      body_truncated: body.length > BODY_SAMPLE_LIMIT,
    };
  } finally {
    clearTimeout(timer);
  }
}

function serviceHeaders(context) {
  return context.serviceKey ? { apikey: context.serviceKey } : {};
}

function urlFor(context, path) {
  const templated = path.replaceAll("{project_id}", context.projectId);
  if (/^https?:\/\//.test(templated)) return templated;
  return `${context.baseUrl}/${stripLeadingSlash(templated)}`;
}

function looksLikeSsrStub(response) {
  const text = response.body_sample.toLowerCase();
  return text.includes("ssr stub") ||
    text.includes("dynamic runtime is not configured") ||
    text.includes("dynamic_runtime_unavailable");
}

function redactValue(value, secrets) {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = sensitiveKey(key) ? "[redacted]" : redactValue(child, secrets);
    }
    return out;
  }
  if (typeof value !== "string") return value;
  let out = value;
  for (const secret of secrets) {
    out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}\b/gi, "Bearer [redacted]")
    .replace(/\b(authorization|cookie|set-cookie|apikey|api-key|x-api-key|x-run402-payment|x-402-payment|payment|service[_-]?key|token|secret)\s*[:=]\s*[^ \r\n\t,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:sk|pk|rk|r402|run402|secret|token|api[_-]?key)[A-Za-z0-9_-]*[:=_-][A-Za-z0-9._~+/=-]{8,}\b/gi, "[redacted]");
}

function sensitiveKey(key) {
  return /^(authorization|cookie|set-cookie|apikey|api_key|api-key|service_key|service-key|token|secret|password|signed_url|signedUrl)$/i.test(key);
}

function headersToObject(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function errorEvidence(err) {
  return err instanceof Error
    ? { name: err.name, message: err.message, stack: err.stack?.split("\n").slice(0, 3).join("\n") }
    : { message: String(err) };
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Certification config requires ${name}.`);
  }
  return value.trim();
}

function stripSlash(value) {
  return value.replace(/\/+$/, "");
}

function stripLeadingSlash(value) {
  return value.replace(/^\/+/, "");
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.config) {
    process.stderr.write("Usage: node scripts/core-certify.mjs --config core-certify.json [--out evidence.json]\n");
    process.exit(2);
  }
  const config = JSON.parse(await readFile(args.config, "utf-8"));
  const evidence = await runCertification(config);
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  if (args.out) {
    await writeFile(args.out, json, "utf-8");
  } else {
    process.stdout.write(json);
  }
  if (evidence.status !== "pass") process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      out.config = argv[++i];
    } else if (arg.startsWith("--config=")) {
      out.config = arg.slice("--config=".length);
    } else if (arg === "--out") {
      out.out = argv[++i];
    } else if (arg.startsWith("--out=")) {
      out.out = arg.slice("--out=".length);
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main(process.argv.slice(2));
}
