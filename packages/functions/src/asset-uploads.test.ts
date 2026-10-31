import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

mock.module("./config.js", {
  namedExports: {
    config: { API_BASE: "https://test.run402.com", PROJECT_ID: "prj_test", SERVICE_KEY: "sk_test" },
  },
});

const { assets } = await import("./assets.js");
const { uploads, Run402UploadError } = await import("./asset-uploads.js");

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function state(over: Record<string, unknown> = {}) {
  return {
    upload_id: ID, key: "contributed/m1/u/scans.zip", status: "active", mode: "multipart", size_bytes: 20 * 1024 * 1024,
    content_type: "application/zip", visibility: "private", part_size_bytes: 8 * 1024 * 1024, part_count: 3,
    owner: "m1", metadata: null, expires_at: "2026-11-01T00:00:00.000Z", ...over,
  };
}

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

function gateway(reply: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
    const c: Call = {
      url, method: String(opts.method), headers: opts.headers as Record<string, string>,
      body: opts.body ? JSON.parse(String(opts.body)) : undefined,
    };
    calls.push(c);
    const r = reply(c);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

describe("assets.*Upload primitives", () => {
  beforeEach(() => mock.restoreAll());

  it("createUpload posts snake_case fields with the service key", async () => {
    const calls = gateway(() => ({ status: 201, body: state() }));
    const out = await assets.createUpload("contributed/m1/u/scans.zip", {
      sizeBytes: 20 * 1024 * 1024, contentType: "application/zip", visibility: "private",
      exifPolicy: "strip", metadata: { uploaded_by: "m1" }, owner: "m1", onComplete: { function: "uploads" }, ttlSeconds: 7200,
    });
    assert.equal(out.upload_id, ID);
    assert.equal(calls[0]!.url, "https://test.run402.com/apply/v1/asset-uploads");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.Authorization, "Bearer sk_test");
    assert.deepEqual(calls[0]!.body, {
      key: "contributed/m1/u/scans.zip", size_bytes: 20971520, content_type: "application/zip", visibility: "private",
      exif_policy: "strip", metadata: { uploaded_by: "m1" }, owner: "m1", on_complete: { function: "uploads" }, ttl_seconds: 7200,
    });
  });

  it("validates before any HTTP call", async () => {
    const calls = gateway(() => ({ status: 201, body: state() }));
    await assert.rejects(assets.createUpload("", { sizeBytes: 1, contentType: "a/b" }), Run402UploadError);
    await assert.rejects(assets.createUpload("k", { sizeBytes: 0, contentType: "a/b" }), /sizeBytes/);
    await assert.rejects(assets.createUpload("k", { sizeBytes: 1, contentType: "zip" }), /contentType/);
    await assert.rejects(assets.getUpload("nope"), /uploadId/);
    assert.equal(calls.length, 0);
  });

  it("routes renew, read, complete and abort to their paths", async () => {
    const calls = gateway(() => ({ status: 200, body: state() }));
    await assets.renewUpload(ID, { partNumbers: [2] });
    await assets.getUpload(ID);
    await assets.completeUpload(ID);
    await assets.abortUpload(ID);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace("https://test.run402.com", "")}`), [
      `POST /apply/v1/asset-uploads/${ID}/urls`,
      `GET /apply/v1/asset-uploads/${ID}`,
      `POST /apply/v1/asset-uploads/${ID}/complete`,
      `DELETE /apply/v1/asset-uploads/${ID}`,
    ]);
    assert.deepEqual(calls[0]!.body, { part_numbers: [2] });
  });

  it("throws Run402UploadError carrying the gateway's code, details and next_actions", async () => {
    gateway(() => ({ status: 403, body: { code: "QUOTA_EXCEEDED", message: "over", details: { storage_limit: "250 MB" }, next_actions: [{ type: "renew_tier" }] } }));
    await assert.rejects(assets.createUpload("k", { sizeBytes: 1, contentType: "a/b" }), (err: InstanceType<typeof Run402UploadError>) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, "QUOTA_EXCEEDED");
      assert.deepEqual(err.details, { storage_limit: "250 MB" });
      assert.equal((err.next_actions as Array<{ type: string }>)[0]!.type, "renew_tier");
      return true;
    });
  });
});

describe("uploads.handler", () => {
  beforeEach(() => {
    mock.restoreAll();
    process.env.RUN402_FUNCTION_NAME = "uploads";
  });

  const handle = (onComplete?: (a: Record<string, unknown>) => void) => uploads.handler({
    identify: (req) => req.headers.get("x-member"),
    authorize: (file, owner) => file.size > 10 * 1024 * 1024 * 1024
      ? { refuse: "Too large" }
      : { key: `contributed/${owner}/u/${file.name}`, visibility: "private", metadata: { uploaded_by: owner } },
    onComplete,
  });

  it("opens an upload for a signed-in member with their owner tag and its own completion run", async () => {
    const calls = gateway(() => ({ status: 201, body: state() }));
    const res = await handle(() => {})(new Request("https://app.example/api/uploads", {
      method: "POST", headers: { "x-member": "m1" }, body: JSON.stringify({ name: "scans.zip", size: 20971520, type: "application/zip" }),
    }));
    assert.equal(res.status, 201);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.upload_id, ID);
    assert.equal("owner" in body, false, "the owner tag never reaches the browser");
    assert.deepEqual(calls[0]!.body, {
      key: "contributed/m1/u/scans.zip", size_bytes: 20971520, content_type: "application/zip", visibility: "private",
      metadata: { uploaded_by: "m1" }, owner: "m1", on_complete: { function: "uploads" },
    });
  });

  it("answers 401 without a member and 403 with the refusal", async () => {
    gateway(() => ({ status: 201, body: state() }));
    const anon = await handle()(new Request("https://app.example/api/uploads", { method: "POST", body: "{}" }));
    assert.equal(anon.status, 401);
    const big = await handle()(new Request("https://app.example/api/uploads", {
      method: "POST", headers: { "x-member": "m1" }, body: JSON.stringify({ name: "x", size: 11 * 1024 ** 3, type: "a/b" }),
    }));
    assert.equal(big.status, 403);
    assert.equal(((await big.json()) as { message: string }).message, "Too large");
  });

  it("answers 404 when another member touches the upload", async () => {
    gateway(() => ({ status: 200, body: state({ owner: "m1" }) }));
    const res = await handle()(new Request(`https://app.example/api/uploads/${ID}`, { headers: { "x-member": "m2" } }));
    assert.equal(res.status, 404);
  });

  it("serves read, renew, complete (202 while verifying) and abort for the owner", async () => {
    const calls = gateway((c) => {
      if (c.url.endsWith("/complete")) return { status: 202, body: state({ status: "verifying" }) };
      return { status: 200, body: state() };
    });
    const h = handle();
    const hdr = { "x-member": "m1" };
    assert.equal((await h(new Request(`https://app.example/api/uploads/${ID}`, { headers: hdr }))).status, 200);
    assert.equal((await h(new Request(`https://app.example/api/uploads/${ID}/urls`, { method: "POST", headers: hdr, body: JSON.stringify({ part_numbers: [3] }) }))).status, 200);
    assert.equal((await h(new Request(`https://app.example/api/uploads/${ID}/complete`, { method: "POST", headers: hdr }))).status, 202);
    assert.equal((await h(new Request(`https://app.example/api/uploads/${ID}`, { method: "DELETE", headers: hdr }))).status, 200);
    const renew = calls.find((c) => c.url.endsWith("/urls"));
    assert.deepEqual(renew!.body, { part_numbers: [3] });
  });

  it("calls onComplete once, from the completion run, with the stored asset", async () => {
    gateway(() => ({ status: 200, body: state({ status: "completed", asset: { key: "contributed/m1/u/scans.zip", sha256: "ab" } }) }));
    const got: Array<Record<string, unknown>> = [];
    const envelope = {
      trigger: "function_run", run_id: "fnrun_1", generation: 1, event_type: "asset_upload.completed",
      idempotency_key: `asset_upload:${ID}`, run_at: "2026-10-31T00:00:00.000Z",
      attempt: { attempt_id: "fnatt_1", number: 1, max: 5 }, source: { type: "asset_upload", upload_id: ID },
      payload: { upload_id: ID, key: "contributed/m1/u/scans.zip", status: "completed" },
    };
    const res = await handle((a) => { got.push(a); })(new Request("https://app.example/api/uploads", {
      method: "POST", headers: { "x-run402-trigger": "function_run" }, body: JSON.stringify(envelope),
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(got, [{ key: "contributed/m1/u/scans.zip", sha256: "ab" }]);
  });
});
