import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const baseUrl = process.env.CORE_SMOKE_BASE_URL || "http://127.0.0.1:4020";
const fixtureDir = new URL("../fixtures/storage-routing-core/", import.meta.url);
const restartEnabled = process.env.CORE_CONFORMANCE_RESTART === "1";

const project = await postJson("/projects/v1", { name: "core-storage-routing-smoke" });
const serviceHeaders = { apikey: project.service_key };

const files = {
  events: await fixtureFile("site/events.html", "text/html"),
  login: await fixtureFile("site/login.html", "text/html"),
  css: await fixtureFile("site/assets/app.css", "text/css"),
  hidden: await fixtureFile("site/hidden.txt", "text/plain"),
  publicObject: await fixtureFile("objects/public.txt", "text/plain"),
  privateObject: await fixtureFile("objects/private.txt", "text/plain"),
  immutableV1: await fixtureFile("objects/immutable-v1.txt", "text/plain"),
  overwriteV1: await fixtureFile("objects/asset-overwrite-v1.txt", "text/plain"),
  overwriteV2: await fixtureFile("objects/asset-overwrite-v2.txt", "text/plain"),
  syncKeep: await fixtureFile("objects/sync-keep.txt", "text/plain"),
  syncRemove: await fixtureFile("objects/sync-remove.txt", "text/plain"),
};

for (const file of Object.values(files)) {
  await stageContent(project.project_id, file);
}

const publicUpload = await uploadObject("fixture/upload-public.txt", files.publicObject, "public", true);
const privateUpload = await uploadObject("fixture/upload-private.txt", files.privateObject, "private", true);
const immutableUpload = await uploadObject("fixture/upload-immutable.txt", files.immutableV1, "public", true);
const immutableUrl = immutableUpload.immutable_url;
if (!immutableUrl) {
  throw new Error(`Expected immutable upload URL, got ${JSON.stringify(immutableUpload)}`);
}

await expectBytes(publicUpload.public_url, files.publicObject.bytes, "public object anonymous read");
await expectStorageNotFound(`/projects/v1/${project.project_id}/storage/public/fixture/upload-private.txt`);
await expectBytes(
  `/projects/v1/${project.project_id}/storage/blob/fixture/upload-private.txt`,
  files.privateObject.bytes,
  "private object authenticated read",
  serviceHeaders,
);
const signedPrivate = await postJson(
  `/projects/v1/${project.project_id}/storage/blob/fixture/upload-private.txt/sign`,
  { ttl_seconds: 120 },
  serviceHeaders,
);
await expectBytes(signedPrivate.signed_url, files.privateObject.bytes, "private object signed read");

const listed = await getJson(`/projects/v1/${project.project_id}/storage/objects?prefix=fixture/&limit=2`, serviceHeaders);
if (listed.objects.length !== 2 || !listed.next_cursor) {
  throw new Error(`Expected paginated fixture listing, got ${JSON.stringify(listed)}`);
}
const listedNext = await getJson(
  `/projects/v1/${project.project_id}/storage/objects?prefix=fixture/&limit=2&cursor=${encodeURIComponent(listed.next_cursor)}`,
  serviceHeaders,
);
if (listedNext.objects.length !== 1 || listedNext.next_cursor !== null) {
  throw new Error(`Expected second listing page with one object, got ${JSON.stringify(listedNext)}`);
}
const uploadKeys = [...listed.objects, ...listedNext.objects]
  .map((object) => object.key)
  .filter((key) => key.startsWith("fixture/upload-"))
  .sort();
if (uploadKeys.join(",") !== "fixture/upload-immutable.txt,fixture/upload-private.txt,fixture/upload-public.txt") {
  throw new Error(`Expected upload keys in paginated listing, got ${JSON.stringify(uploadKeys)}`);
}

await deleteJson(`/projects/v1/${project.project_id}/storage/blob/fixture/upload-immutable.txt`, serviceHeaders);
await expectStorageNotFound(`/projects/v1/${project.project_id}/storage/public/fixture/upload-immutable.txt`);
await expectBytes(immutableUrl, files.immutableV1.bytes, "immutable object read after mutable delete");

const firstRelease = await applySpec(storageRoutingSpec({
  extraAssetPuts: [
    assetPut("fixture/overwrite.txt", files.overwriteV1, "public", true),
    assetPut("fixture/prune/keep.txt", files.syncKeep, "public", true),
    assetPut("fixture/prune/remove.txt", files.syncRemove, "public", true),
  ],
}));

await expectBytes(`/projects/v1/${project.project_id}/static/events?ignored=true`, files.events.bytes, "explicit public path");
await expectBytes(`/projects/v1/${project.project_id}/static/login/`, files.login.bytes, "static alias trailing slash");
await expectHead(`/projects/v1/${project.project_id}/static/login`, files.login.bytes.byteLength);
await expectBytes(`/projects/v1/${project.project_id}/static/assets/app.css`, files.css.bytes, "route miss then static lookup");
await expectStaticNotFound(`/projects/v1/${project.project_id}/static/login.html`);
await expectStaticNotFound(`/projects/v1/${project.project_id}/static/hidden.txt`);
await expectStatus("POST", `/projects/v1/${project.project_id}/static/login`, 405);

const diagnostics = await getJson(`/projects/v1/${project.project_id}/static-diagnostics`, serviceHeaders);
if (!diagnostics.public_paths.some((entry) => entry.public_path === "/events" && entry.asset_path === "events.html")) {
  throw new Error(`Static diagnostics did not report /events: ${JSON.stringify(diagnostics)}`);
}
if (!diagnostics.public_paths.some((entry) => entry.public_path === "/login" && entry.asset_path === "login.html" && entry.authority === "route_static_alias")) {
  throw new Error(`Static diagnostics did not report /login alias: ${JSON.stringify(diagnostics)}`);
}
if (!diagnostics.non_public_asset_paths.includes("hidden.txt")) {
  throw new Error(`Static diagnostics did not hide hidden.txt: ${JSON.stringify(diagnostics)}`);
}

await expectPostJsonFailure("/apply/v1/plans", {
  spec: storageRoutingSpec({
    routes: [
      {
        pattern: "/events",
        methods: ["GET", "HEAD"],
        target: { type: "static", file: "login.html" },
      },
    ],
  }),
}, 400, "invalid_release_spec");

await expectPostJsonFailure("/apply/v1/plans", {
  spec: {
    project: project.project_id,
    routes: {
      replace: [
        {
          pattern: "/api/*",
          methods: ["GET"],
          target: { type: "function", name: "api" },
        },
      ],
    },
  },
}, 400, "invalid_release_spec");

await applySpec(storageRoutingSpec({
  base: { release: "current" },
  extraAssetPuts: [
    assetPut("fixture/overwrite.txt", files.overwriteV2, "public", true),
    assetPut("fixture/prune/keep.txt", files.syncKeep, "public", true),
  ],
  syncPrefix: "fixture/prune/",
}));

await expectBytes(
  `/projects/v1/${project.project_id}/storage/public/fixture/overwrite.txt`,
  files.overwriteV2.bytes,
  "asset overwrite read",
);
await expectBytes(
  `/projects/v1/${project.project_id}/storage/public/fixture/prune/keep.txt`,
  files.syncKeep.bytes,
  "sync-prune kept object read",
);
await expectStorageNotFound(`/projects/v1/${project.project_id}/storage/public/fixture/prune/remove.txt`);

await deleteJson(`/projects/v1/${project.project_id}/storage/blob/fixture/upload-public.txt`, serviceHeaders);
await expectStorageNotFound(`/projects/v1/${project.project_id}/storage/public/fixture/upload-public.txt`);
const cleanup = await postJson(`/projects/v1/${project.project_id}/storage/cleanup`, {}, serviceHeaders);
if (!Array.isArray(cleanup.retained_live_sha256) || !cleanup.retained_live_sha256.includes(files.syncKeep.sha256)) {
  throw new Error(`Cleanup did not report retained live storage refs: ${JSON.stringify(cleanup)}`);
}
await expectBytes(immutableUrl, files.immutableV1.bytes, "immutable object read after cleanup");

if (restartEnabled) {
  await restartCore();
  await expectBytes(`/projects/v1/${project.project_id}/static/events`, files.events.bytes, "explicit public path after restart");
  await expectBytes(
    `/projects/v1/${project.project_id}/storage/public/fixture/prune/keep.txt`,
    files.syncKeep.bytes,
    "public storage after restart",
  );
  await expectStorageNotFound(`/projects/v1/${project.project_id}/storage/public/fixture/upload-private.txt`);
  await expectBytes(
    `/projects/v1/${project.project_id}/storage/blob/fixture/upload-private.txt`,
    files.privateObject.bytes,
    "private storage after restart",
    serviceHeaders,
  );
}

console.log(JSON.stringify({
  status: "ok",
  project_id: project.project_id,
  release_id: firstRelease.release_id,
  storage_checks: [
    "upload",
    "complete",
    "list-pagination",
    "anonymous-public-read",
    "private-read-denial",
    "authenticated-private-read",
    "signed-read",
    "immutable-url-retention",
    "delete",
    "cleanup-visible-retention",
    ...(restartEnabled ? ["restart-persistence"] : []),
  ],
  routing_checks: [
    "explicit-public-path",
    "static-alias",
    "head-get",
    "route-miss-static-lookup",
    "private-asset-nondisclosure",
    "route-conflict-rejection",
    "missing-dynamic-target-rejection",
  ],
}, null, 2));

async function fixtureFile(relativePath, contentType) {
  const bytes = await readFile(new URL(relativePath, fixtureDir));
  return {
    relativePath,
    bytes,
    sha256: sha256Hex(bytes),
    size: bytes.byteLength,
    contentType,
  };
}

async function stageContent(projectId, file) {
  await postJson(`/projects/v1/${projectId}/content`, {
    sha256: file.sha256,
    size: file.size,
    content_type: file.contentType,
    bytes_base64: file.bytes.toString("base64"),
  });
}

async function uploadObject(key, file, visibility, immutable) {
  const session = await postJson(
    `/projects/v1/${project.project_id}/storage/uploads`,
    {
      key,
      size_bytes: file.size,
      sha256: file.sha256,
      content_type: file.contentType,
      visibility,
      immutable,
    },
    serviceHeaders,
  );
  await putBytes(session.upload_url, file.bytes, serviceHeaders);
  const object = await postJson(
    `/projects/v1/${project.project_id}/storage/uploads/${session.upload_id}/complete`,
    {},
    serviceHeaders,
  );
  if (object.key !== key || object.sha256 !== file.sha256 || object.visibility !== visibility) {
    throw new Error(`Upload completed with wrong metadata: ${JSON.stringify(object)}`);
  }
  return object;
}

function storageRoutingSpec(options = {}) {
  const routes = options.routes ?? [
    {
      pattern: "/login",
      methods: ["GET", "HEAD"],
      target: { type: "static", file: "login.html" },
    },
  ];
  const extraAssetPuts = options.extraAssetPuts ?? [
    assetPut("fixture/public.txt", files.publicObject, "public", true),
    assetPut("fixture/private.txt", files.privateObject, "private", true),
    assetPut("fixture/prune/keep.txt", files.syncKeep, "public", true),
  ];
  return {
    project: project.project_id,
    base: options.base ?? { release: "current" },
    site: {
      replace: {
        "events.html": contentRef(files.events),
        "login.html": contentRef(files.login),
        "assets/app.css": contentRef(files.css),
        "hidden.txt": contentRef(files.hidden),
      },
      public_paths: {
        mode: "explicit",
        replace: {
          "/events": { asset: "events.html", cache_class: "html" },
          "/assets/app.css": { asset: "assets/app.css", cache_class: "revalidating_asset" },
        },
      },
    },
    routes: { replace: routes },
    assets: {
      put: extraAssetPuts,
      ...(options.deleteAssets ? { delete: options.deleteAssets } : {}),
      ...(options.syncPrefix ? { sync: { prefix: options.syncPrefix, prune: true } } : {}),
    },
  };
}

function contentRef(file) {
  return {
    sha256: file.sha256,
    size: file.size,
    contentType: file.contentType,
  };
}

function assetPut(key, file, visibility, immutable) {
  return {
    key,
    sha256: file.sha256,
    size_bytes: file.size,
    content_type: file.contentType,
    visibility,
    immutable,
  };
}

async function applySpec(spec) {
  const plan = await postJson("/apply/v1/plans", { spec });
  const commit = await postJson(`/apply/v1/plans/${plan.plan_id}/commit`, {
    release_spec_digest: plan.release_spec_digest,
  });
  if (commit.status !== "committed" && commit.status !== "noop") {
    throw new Error(`Expected committed or noop apply, got ${JSON.stringify(commit)}`);
  }
  return commit;
}

async function postJson(pathOrUrl, body, headers = {}) {
  const response = await fetch(resolveUrl(pathOrUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${pathOrUrl} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function getJson(pathOrUrl, headers = {}) {
  const response = await fetch(resolveUrl(pathOrUrl), {
    headers,
  });
  if (!response.ok) {
    throw new Error(`GET ${pathOrUrl} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function deleteJson(pathOrUrl, headers = {}) {
  const response = await fetch(resolveUrl(pathOrUrl), {
    method: "DELETE",
    headers,
  });
  if (!response.ok) {
    throw new Error(`DELETE ${pathOrUrl} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function putBytes(pathOrUrl, bytes, headers = {}) {
  const response = await fetch(resolveUrl(pathOrUrl), {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      ...headers,
    },
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(`PUT ${pathOrUrl} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function expectBytes(pathOrUrl, expected, label, headers = {}) {
  const response = await fetch(resolveUrl(pathOrUrl), { headers });
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${await response.text()}`);
  }
  const actual = Buffer.from(await response.arrayBuffer());
  if (!actual.equals(expected)) {
    throw new Error(`${label} returned unexpected bytes: ${actual.toString("utf8")}`);
  }
  const digest = response.headers.get("x-run402-content-sha256");
  if (digest && digest !== sha256Hex(expected)) {
    throw new Error(`${label} returned wrong digest ${digest}`);
  }
}

async function expectHead(pathOrUrl, expectedLength) {
  const response = await fetch(resolveUrl(pathOrUrl), { method: "HEAD" });
  if (!response.ok) {
    throw new Error(`HEAD ${pathOrUrl} failed: ${response.status} ${await response.text()}`);
  }
  if (response.headers.get("content-length") !== String(expectedLength)) {
    throw new Error(`HEAD ${pathOrUrl} returned wrong length ${response.headers.get("content-length")}`);
  }
  const actual = Buffer.from(await response.arrayBuffer());
  if (actual.byteLength !== 0) {
    throw new Error(`HEAD ${pathOrUrl} returned a body`);
  }
}

async function expectStorageNotFound(pathOrUrl) {
  const response = await fetch(resolveUrl(pathOrUrl));
  const text = await response.text();
  if (response.status !== 404) {
    throw new Error(`Expected storage 404 for ${pathOrUrl}, got ${response.status} ${text}`);
  }
  const parsed = JSON.parse(text);
  if (parsed.error !== "storage_not_found") {
    throw new Error(`Expected storage_not_found for ${pathOrUrl}, got ${text}`);
  }
}

async function expectStaticNotFound(pathOrUrl) {
  const response = await fetch(resolveUrl(pathOrUrl));
  const text = await response.text();
  if (response.status !== 404) {
    throw new Error(`Expected static 404 for ${pathOrUrl}, got ${response.status} ${text}`);
  }
  const parsed = JSON.parse(text);
  if (parsed.error !== "static_not_found") {
    throw new Error(`Expected static_not_found for ${pathOrUrl}, got ${text}`);
  }
}

async function expectStatus(method, pathOrUrl, status) {
  const response = await fetch(resolveUrl(pathOrUrl), { method });
  const text = await response.text();
  if (response.status !== status) {
    throw new Error(`Expected ${method} ${pathOrUrl} to return ${status}, got ${response.status} ${text}`);
  }
}

async function expectPostJsonFailure(pathOrUrl, body, expectedStatus, expectedError) {
  const response = await fetch(resolveUrl(pathOrUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`Expected POST ${pathOrUrl} to fail with ${expectedStatus}, got ${response.status} ${text}`);
  }
  const parsed = JSON.parse(text);
  if (parsed.error !== expectedError) {
    throw new Error(`Expected POST ${pathOrUrl} error ${expectedError}, got ${text}`);
  }
}

async function restartCore() {
  await execFileAsync("docker", ["compose", "restart", "core"], {
    cwd: new URL("../", import.meta.url).pathname,
    timeout: 120_000,
  });
  await waitForHealth();
}

async function waitForHealth() {
  let lastError = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Core did not become healthy after restart: ${lastError}`);
}

function resolveUrl(pathOrUrl) {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return `${baseUrl}${pathOrUrl}`;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
