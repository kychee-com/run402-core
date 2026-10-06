import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const config = {
  API_BASE: "https://test.run402.com",
  PROJECT_ID: "prj_test",
  SERVICE_KEY: "sk_test",
};

mock.module("./config.js", { namedExports: { config } });

const { snapshots, R402SnapshotsError } = await import("./snapshots.js");
const index = await import("./index.js");

const BASE = "https://test.run402.com/projects/v1/prj_test/snapshots";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[] = [];
let respond: (call: Call) => Response = () => new Response("{}", { status: 200 });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  config.PROJECT_ID = "prj_test";
  mock.method(globalThis, "fetch", async (url: string, opts: RequestInit = {}) => {
    const call: Call = {
      url,
      method: opts.method ?? "GET",
      headers: (opts.headers ?? {}) as Record<string, string>,
      body: opts.body ? JSON.parse(String(opts.body)) : undefined,
    };
    calls.push(call);
    return respond(call);
  });
});

describe("snapshots — exports", () => {
  it("is exported from the package root", () => {
    assert.equal(index.snapshots, snapshots);
    assert.equal(index.R402SnapshotsError, R402SnapshotsError);
  });

  it("takes no project id or credential argument anywhere", () => {
    for (const fn of Object.values(snapshots)) {
      assert.ok(fn.length <= 3);
    }
    assert.deepEqual(Object.keys(snapshots).sort(), ["create", "delete", "get", "getRestore", "list", "restore", "restorePlan"]);
  });
});

describe("snapshots.create", () => {
  it("posts label and metadata with the service key to its own project", async () => {
    respond = () => json({ snapshot_id: "snap_1", label: "before re-import", created_by: { credential_kind: "service_key", principal_id: null } }, 201);
    const snap = await snapshots.create({ label: "  before re-import ", metadata: { source: "csv" } });
    assert.equal(snap.created_by.credential_kind, "service_key");
    assert.equal(calls[0].url, BASE);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.Authorization, "Bearer sk_test");
    assert.deepEqual(calls[0].body, { label: "before re-import", metadata: { source: "csv" } });
  });

  it("rejects nested metadata before any request", async () => {
    await assert.rejects(
      () => snapshots.create({ metadata: { nested: { a: 1 } } as never }),
      (err: unknown) => err instanceof R402SnapshotsError && err.code === "VALIDATION_FAILED" && err.field === "metadata.nested",
    );
    assert.equal(calls.length, 0);
  });

  it("rejects oversized metadata and bad labels before any request", async () => {
    await assert.rejects(() => snapshots.create({ metadata: { big: "x".repeat(5000) } }), (err: unknown) =>
      err instanceof R402SnapshotsError && err.field === "metadata");
    await assert.rejects(() => snapshots.create({ label: "a".repeat(121) }), (err: unknown) =>
      err instanceof R402SnapshotsError && err.field === "label");
    await assert.rejects(() => snapshots.create({ label: "two\nlines" }), (err: unknown) =>
      err instanceof R402SnapshotsError && err.field === "label");
    assert.equal(calls.length, 0);
  });

  it("surfaces the gateway cap refusal with its code and next actions", async () => {
    respond = () => json({
      error: "too many",
      message: "Manual snapshot cap reached",
      code: "SNAPSHOT_MANUAL_CAP_EXCEEDED",
      details: { cap: 20 },
      next_actions: [{ type: "delete", why: "Delete an old manual snapshot." }],
    }, 409);
    await assert.rejects(() => snapshots.create({ label: "one more" }), (err: unknown) => {
      assert.ok(err instanceof R402SnapshotsError);
      assert.equal(err.code, "SNAPSHOT_MANUAL_CAP_EXCEEDED");
      assert.equal(err.status, 409);
      assert.deepEqual(err.details, { cap: 20 });
      assert.equal(err.next_actions[0].type, "delete");
      return true;
    });
  });

  it("requires RUN402_PROJECT_ID", async () => {
    config.PROJECT_ID = "";
    await assert.rejects(() => snapshots.list(), (err: unknown) =>
      err instanceof R402SnapshotsError && err.code === "PROJECT_ID_MISSING");
    assert.equal(calls.length, 0);
  });
});

describe("snapshots.list / get / delete", () => {
  it("lists with query parameters", async () => {
    respond = () => json({ snapshots: [], has_more: false, next_cursor: null });
    await snapshots.list({ limit: 5, kind: "manual", after: "cur" });
    assert.equal(calls[0].url, `${BASE}?limit=5&after=cur&kind=manual`);
  });

  it("gets and deletes by id", async () => {
    respond = (call) => (call.method === "DELETE" ? new Response(null, { status: 204 }) : json({ snapshot_id: "snap_1" }));
    await snapshots.get("snap_1");
    await snapshots.delete("snap_1");
    assert.equal(calls[0].url, `${BASE}/snap_1`);
    assert.equal(calls[1].method, "DELETE");
  });
});

describe("snapshots.restorePlan / restore / getRestore", () => {
  it("plans with the release mode and unwraps restore_plan", async () => {
    respond = () => json({ restore_plan: { snapshot_id: "snap_1", confirm: { token: "tok" }, release: { mode: "snapshot" } } });
    const plan = await snapshots.restorePlan("snap_1", { release: "snapshot" });
    assert.equal(plan.confirm.token, "tok");
    assert.equal(calls[0].url, `${BASE}/snap_1/restore`);
    assert.deepEqual(calls[0].body, { release: "snapshot" });
  });

  it("confirms without waiting and returns the handle", async () => {
    respond = () => json({ restore_id: "rst_1", status: "running", retry_after_seconds: 5, next_actions: [] }, 202);
    const handle = await snapshots.restore("snap_1", "tok", { release: "snapshot" });
    assert.equal(handle.status, "running");
    assert.deepEqual(calls[0].body, { confirm: "tok", wait: false, release: "snapshot" });
  });

  it("never sends an auth-identity option", async () => {
    respond = () => json({ restore_id: "rst_1", status: "running" }, 202);
    await snapshots.restore("snap_1", "tok", { include: ["auth"] } as never);
    assert.equal((calls[0].body as Record<string, unknown>).include, undefined);
  });

  it("rejects an unknown release mode locally", async () => {
    await assert.rejects(() => snapshots.restore("snap_1", "tok", { release: "latest" as never }), (err: unknown) =>
      err instanceof R402SnapshotsError && err.field === "release");
    assert.equal(calls.length, 0);
  });

  it("reads restore status", async () => {
    respond = () => json({ restore_id: "rst_1", status: "ready", result: { restore_id: "rst_1" } });
    const status = await snapshots.getRestore("snap_1", "rst_1");
    assert.equal(status.status, "ready");
    assert.equal(calls[0].url, `${BASE}/snap_1/restores/rst_1`);
  });
});

describe("snapshots — hosts without snapshots", () => {
  it("maps Cloud's catch-all route 404 to SNAPSHOTS_UNSUPPORTED", async () => {
    respond = () => json({ error: "Cannot GET /projects/v1/prj_test/snapshots", message: "Cannot GET /projects/v1/prj_test/snapshots", code: "RESOURCE_NOT_FOUND" }, 404);
    await assert.rejects(() => snapshots.list(), (err: unknown) =>
      err instanceof R402SnapshotsError && err.code === "SNAPSHOTS_UNSUPPORTED");
  });

  it("maps a 404 without a Run402 code (Core) to SNAPSHOTS_UNSUPPORTED", async () => {
    respond = () => new Response("Not Found", { status: 404 });
    await assert.rejects(() => snapshots.list(), (err: unknown) =>
      err instanceof R402SnapshotsError && err.code === "SNAPSHOTS_UNSUPPORTED");
  });

  it("keeps a real snapshot-not-found as RESOURCE_NOT_FOUND", async () => {
    respond = () => json({ error: "snapshot not found", message: "snapshot not found", code: "RESOURCE_NOT_FOUND" }, 404);
    await assert.rejects(() => snapshots.get("snap_x"), (err: unknown) =>
      err instanceof R402SnapshotsError && err.code === "RESOURCE_NOT_FOUND");
  });
});
