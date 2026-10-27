import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const config = {
  API_BASE: "https://test.run402.com",
  PROJECT_ID: "prj_test",
  SERVICE_KEY: "sk_test",
  ANON_KEY: "anon_test",
};

mock.module("./config.js", { namedExports: { config } });

const { repo, repos, R402AppRepoError } = await import("./repo.js");
const { runWithContext } = await import("./runtime-context.js");
const index = await import("./index.js");

const BASE = "https://test.run402.com/projects/v1/prj_test/app-repos";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response> = () => new Response("{}", { status: 200 });

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function file(text: string, commit: string): Response {
  return new Response(text, { status: 200, headers: { "x-run402-commit": commit, etag: '"blob"' } });
}

function pathNotFound(commit?: string): Response {
  return json(
    { code: "APP_REPO_PATH_NOT_FOUND", message: "No such file" },
    404,
    commit ? { "x-run402-commit": commit } : {},
  );
}

function inRequest<T>(fn: () => Promise<T>, headers: Record<string, string> = {}): Promise<T> {
  return runWithContext(
    {
      requestId: "req_test",
      projectId: "prj_test",
      releaseId: "rel_test",
      locale: null,
      defaultLocale: null,
      host: "app.test",
      request: { method: "POST", url: "/save", headers },
      actor: null,
    },
    fn,
  ) as Promise<T>;
}

/** `?at=` of a call, or null. */
function atOf(call: Call): string | null {
  return new URL(call.url).searchParams.get("at");
}

beforeEach(() => {
  calls = [];
  config.PROJECT_ID = "prj_test";
  respond = () => new Response("{}", { status: 200 });
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

describe("repo — exports", () => {
  it("is exported from the package root", () => {
    assert.equal(index.repo, repo);
    assert.equal(index.repos, repos);
    assert.equal(index.R402AppRepoError, R402AppRepoError);
    assert.equal(repo.name, "default");
    assert.equal(repos.open("default"), repo);
  });
});

describe("repo reads", () => {
  it("reads a file with the service key, encoding each path segment", async () => {
    respond = () => file("hello", "c1");
    assert.equal(await repo.read("people/a b.txt"), "hello");
    assert.equal(calls[0].url, `${BASE}/default/files/people/a%20b.txt`);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].headers.Authorization, "Bearer sk_test");
    assert.equal(calls[0].headers["x-run402-actor-token"], undefined);
  });

  it("returns null when the file is absent", async () => {
    respond = () => pathNotFound("c1");
    assert.equal(await repo.read("missing.txt"), null);
    assert.equal(await repo.readBytes("missing.txt"), null);
    assert.equal(await repo.readJson("missing.json"), null);
  });

  it("throws APP_REPO_NOT_FOUND for a repo that does not exist", async () => {
    respond = () =>
      json(
        {
          code: "APP_REPO_NOT_FOUND",
          message: "No app repo user-42",
          next_actions: [{ type: "create_app_repo", method: "POST", path: "/projects/v1/prj_test/app-repos" }],
        },
        404,
      );
    await assert.rejects(() => repos.open("user-42").read("a.txt"), (err: unknown) => {
      assert.ok(err instanceof R402AppRepoError);
      assert.equal(err.code, "APP_REPO_NOT_FOUND");
      assert.equal(err.status, 404);
      assert.equal(err.next_actions[0].type, "create_app_repo");
      return true;
    });
    assert.equal(calls[0].url, `${BASE}/user-42/files/a.txt`);
  });

  it("readBytes returns bytes and readJson parses", async () => {
    respond = (call) =>
      call.url.endsWith("bin") ? new Response(new Uint8Array([0, 1, 255]), { headers: { "x-run402-commit": "c1" } }) : file('{"a":1}', "c1");
    assert.deepEqual(await repo.readBytes("x.bin"), new Uint8Array([0, 1, 255]));
    assert.deepEqual(await repo.readJson("site.json"), { a: 1 });
  });

  it("readJson throws APP_REPO_INVALID_JSON for a file that is not JSON", async () => {
    respond = () => file("not json", "c1");
    await assert.rejects(() => repo.readJson("site.json"), (err: unknown) =>
      err instanceof R402AppRepoError && err.code === "APP_REPO_INVALID_JSON");
  });

  it("lists a directory, and an empty repo lists nothing", async () => {
    const entries = [{ name: "a.json", path: "people/a.json", type: "file", size: 3, oid: "o1" }];
    respond = () => json({ commit: "c1", path: "people", entries });
    assert.deepEqual(await repo.list("people/"), entries);
    assert.equal(calls[0].url, `${BASE}/default/tree/people`);
    respond = () => json({ commit: null, path: "", entries: [] });
    assert.deepEqual(await repo.list(), []);
    assert.equal(calls[1].url, `${BASE}/default/tree`);
  });

  it("log and diff pass their query", async () => {
    respond = () => json({ commits: [], head: null, has_more: false, next_cursor: null });
    assert.deepEqual(await repo.log({ path: "people/p-x.json", limit: 10, cursor: "cur" }), {
      commits: [],
      head: null,
      has_more: false,
      next_cursor: null,
    });
    assert.equal(calls[0].url, `${BASE}/default/commits?path=people%2Fp-x.json&limit=10&cursor=cur`);
    respond = () => json({ from: "c1", to: "c2", changes: [] });
    await repo.diff("c1", "c2");
    assert.equal(calls[1].url, `${BASE}/default/diff?from=c1&to=c2`);
  });

  it("maps a missing route (Run402 Core) to APP_REPOS_UNSUPPORTED", async () => {
    respond = () => json({ error: "not_found" }, 404);
    await assert.rejects(() => repo.read("a.txt"), (err: unknown) =>
      err instanceof R402AppRepoError && err.code === "APP_REPOS_UNSUPPORTED" && err.status === 404);
    respond = () => json({ code: "RESOURCE_NOT_FOUND", message: "Cannot GET /projects/v1/prj_test/app-repos" }, 404);
    await assert.rejects(() => repos.list(), (err: unknown) =>
      err instanceof R402AppRepoError && err.code === "APP_REPOS_UNSUPPORTED");
    respond = () => new Response("Not Found", { status: 404 });
    await assert.rejects(() => repo.head(), (err: unknown) =>
      err instanceof R402AppRepoError && err.code === "APP_REPOS_UNSUPPORTED");
  });

  it("requires RUN402_PROJECT_ID", async () => {
    config.PROJECT_ID = "";
    await assert.rejects(() => repo.read("a.txt"), (err: unknown) =>
      err instanceof R402AppRepoError && err.code === "PROJECT_ID_MISSING");
    assert.equal(calls.length, 0);
  });
});

describe("repo — one request reads one commit", () => {
  it("pins the first read's commit and passes it as at= on later reads", async () => {
    respond = (call) => file(call.url.includes("a.json") ? '"a"' : '"b"', "c1");
    await inRequest(async () => {
      await repo.readJson("people/a.json");
      await repo.readJson("people/b.json");
      await repo.list("people");
      assert.equal(await repo.head(), "c1");
    });
    assert.equal(atOf(calls[0]), null);
    assert.equal(atOf(calls[1]), "c1");
    assert.equal(atOf(calls[2]), "c1");
    assert.equal(calls.length, 3, "head() answers from the pin with no call");
  });

  it("pins from a missing file's 404 too", async () => {
    respond = (call) => (call.url.includes("missing") ? pathNotFound("c7") : file("x", "c7"));
    await inRequest(async () => {
      assert.equal(await repo.read("missing.txt"), null);
      await repo.read("there.txt");
    });
    assert.equal(atOf(calls[1]), "c7");
  });

  it("an empty repo pins null: later reads in the request need no call", async () => {
    respond = () => pathNotFound();
    await inRequest(async () => {
      assert.equal(await repo.readJson("site.json"), null);
      assert.equal(await repo.read("other.txt"), null);
      assert.deepEqual(await repo.list(), []);
      assert.equal(await repo.head(), null);
    });
    assert.equal(calls.length, 1);
  });

  it("concurrent first reads resolve the head once", async () => {
    let first = true;
    respond = async () => {
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, 5));
      }
      return file("x", "c1");
    };
    await inRequest(async () => {
      await Promise.all([repo.read("a"), repo.read("b"), repo.read("c")]);
    });
    assert.equal(calls.filter((c) => atOf(c) === null).length, 1);
    assert.equal(calls.filter((c) => atOf(c) === "c1").length, 2);
  });

  it("head() resolves the head once when nothing is pinned", async () => {
    respond = () => json({ repo_name: "default", head: "c3" });
    await inRequest(async () => {
      assert.equal(await repo.head(), "c3");
      assert.equal(await repo.head(), "c3");
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/default`);
  });

  it("each request resolves the head afresh, and pins are per repo", async () => {
    respond = () => file("x", "c1");
    await inRequest(async () => {
      await repo.read("a");
      await repos.open("other").read("a");
    });
    await inRequest(async () => {
      await repo.read("a");
    });
    assert.deepEqual(calls.map(atOf), [null, null, null]);
  });

  it("outside a request context nothing is pinned", async () => {
    respond = () => file("x", "c1");
    await repo.read("a");
    await repo.read("b");
    assert.deepEqual(calls.map(atOf), [null, null]);
  });

  it("an inactive context (after the response) does not pin", async () => {
    respond = () => file("x", "c1");
    await runWithContext(
      {
        requestId: "r",
        projectId: "prj_test",
        releaseId: "rel",
        locale: null,
        defaultLocale: null,
        host: "app.test",
        request: { method: "GET", url: "/", headers: {} },
        actor: null,
        active: { value: false },
      },
      async () => {
        await repo.read("a");
        await repo.read("b");
      },
    );
    assert.deepEqual(calls.map(atOf), [null, null]);
  });

  it("at(commit) reads that commit and cannot write", async () => {
    respond = () => file("old", "c0");
    const old = repo.at("c0");
    assert.equal(await old.read("a.txt"), "old");
    assert.equal(atOf(calls[0]), "c0");
    assert.equal(await old.head(), "c0");
    assert.equal("commit" in old, false);
    assert.equal("revert" in old, false);
  });
});

describe("repo.commit", () => {
  it("encodes plain values: string, bytes, null, JSON", async () => {
    respond = () => json({ committed: true, commit: "c2", parent: "c1", head: "c2", seq: 2, paths: [], author: { name: "a", email: "e" } }, 201);
    await repo.commit({
      "a.txt": "hi",
      "b.bin": new Uint8Array([0, 1, 255]),
      "gone.txt": null,
      "people/a.json": { b: 1, a: 2 },
      "list.json": [1, 2],
      "n.json": 3,
      "t.json": true,
    });
    assert.equal(calls[0].url, `${BASE}/default/commits`);
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, {
      files: {
        "a.txt": { text: "hi" },
        "b.bin": { base64: "AAH/" },
        "gone.txt": null,
        "people/a.json": { json: { b: 1, a: 2 } },
        "list.json": { json: [1, 2] },
        "n.json": { json: 3 },
        "t.json": { json: true },
      },
    });
  });

  it("refuses an undefined value before any request", async () => {
    await assert.rejects(() => repo.commit({ "a.txt": undefined as never }), (err: unknown) =>
      err instanceof R402AppRepoError && err.code === "VALIDATION_FAILED" && err.field === "files.a.txt");
    assert.equal(calls.length, 0);
  });

  it("passes message, author and parent through", async () => {
    respond = () => json({ committed: false, head: "c1" });
    const out = await repo.commit({ "a.txt": "x" }, { message: "m", author: { name: "N", email: "n@x" }, parent: "c1" });
    assert.deepEqual(out, { committed: false, head: "c1" });
    assert.deepEqual(calls[0].body, { files: { "a.txt": { text: "x" } }, message: "m", author: { name: "N", email: "n@x" }, parent: "c1" });
  });

  it("builds on the pinned commit and moves the pin: the request reads its own write", async () => {
    respond = (call) => {
      if (call.method === "POST") {
        return json({ committed: true, commit: "c2", parent: "c1", head: "c2", seq: 2, paths: ["site.json"], author: { name: "a", email: "e" } }, 201);
      }
      return atOf(call) === "c2" ? file('{"title":"new"}', "c2") : file('{"title":"old"}', "c1");
    };
    await inRequest(async () => {
      assert.deepEqual(await repo.readJson("site.json"), { title: "old" });
      await repo.commit({ "site.json": { title: "new" } });
      assert.deepEqual(await repo.readJson("site.json"), { title: "new" });
      assert.equal(await repo.head(), "c2");
    });
    assert.equal((calls[1].body as { base?: string }).base, "c1");
    assert.equal(atOf(calls[2]), "c2");
  });

  it("omits base when nothing is pinned, and a commit in an empty repo moves the pin", async () => {
    respond = (call) =>
      call.method === "POST"
        ? json({ committed: true, commit: "c1", parent: null, head: "c1", seq: 1, paths: ["a"], author: { name: "a", email: "e" } }, 201)
        : atOf(call) === "c1"
          ? file("first", "c1")
          : pathNotFound();
    await inRequest(async () => {
      assert.equal(await repo.read("a"), null);
      await repo.commit({ a: "first" });
      assert.equal(await repo.read("a"), "first");
    });
    assert.equal("base" in (calls[1].body as object), false);
    assert.equal(atOf(calls[2]), "c1");
  });

  it("a conflict keeps the pin and surfaces the gateway's details", async () => {
    respond = (call) =>
      call.method === "POST"
        ? json({
            code: "APP_REPO_CONFLICT",
            message: "people/a.json changed",
            details: { head: "c9", base: "c1", conflicting_paths: ["people/a.json"] },
            next_actions: [{ type: "reread_and_retry" }],
          }, 409)
        : file("x", "c1");
    await inRequest(async () => {
      await repo.read("people/a.json");
      await assert.rejects(() => repo.commit({ "people/a.json": { a: 1 } }), (err: unknown) => {
        assert.ok(err instanceof R402AppRepoError);
        assert.equal(err.code, "APP_REPO_CONFLICT");
        assert.equal(err.status, 409);
        assert.deepEqual(err.details, { head: "c9", base: "c1", conflicting_paths: ["people/a.json"] });
        assert.equal(err.next_actions[0].type, "reread_and_retry");
        return true;
      });
      await repo.read("people/b.json");
    });
    assert.equal(atOf(calls[2]), "c1");
  });

  it("forwards the actor token on commit and revert, never on reads", async () => {
    respond = (call) =>
      call.method === "POST"
        ? json({ committed: true, commit: "c2", parent: "c1", head: "c2", seq: 2, paths: [], author: { name: "a", email: "e" } }, 201)
        : file("x", "c1");
    await inRequest(
      async () => {
        await repo.read("a");
        await repo.list();
        await repo.log();
        await repo.commit({ a: "y" });
        await repo.revert("c2");
      },
      { "x-run402-actor-token": "actor_tok" },
    );
    const reads = calls.filter((c) => c.method === "GET");
    const writes = calls.filter((c) => c.method === "POST");
    assert.equal(reads.length, 3);
    for (const c of reads) assert.equal(c.headers["x-run402-actor-token"], undefined);
    assert.equal(writes.length, 2);
    for (const c of writes) {
      assert.equal(c.headers["x-run402-actor-token"], "actor_tok");
      assert.equal(c.headers.Authorization, "Bearer sk_test");
    }
  });

  it("sends no actor token for an anonymous request", async () => {
    respond = () => json({ committed: false, head: null });
    await inRequest(async () => {
      await repo.commit({ a: "y" });
    });
    assert.equal(calls[0].headers["x-run402-actor-token"], undefined);
  });
});

describe("repo.revert", () => {
  it("posts the commit with the pinned base and moves the pin", async () => {
    respond = (call) =>
      call.method === "POST"
        ? json({ committed: true, commit: "c3", parent: "c2", head: "c3", seq: 3, paths: ["a"], author: { name: "a", email: "e" } }, 201)
        : file("x", atOf(call) ?? "c2");
    await inRequest(async () => {
      await repo.read("a");
      await repo.revert("c2", { message: "undo" });
      await repo.read("a");
    });
    assert.equal(calls[1].url, `${BASE}/default/reverts`);
    assert.deepEqual(calls[1].body, { commit: "c2", message: "undo", base: "c2" });
    assert.equal(atOf(calls[2]), "c3");
  });
});

describe("repos", () => {
  it("open makes no call", () => {
    const handle = repos.open("user-42");
    assert.equal(handle.name, "user-42");
    assert.equal(calls.length, 0);
  });

  it("create posts repo_name and from", async () => {
    respond = () => json({ repo_name: "user-42", head: "c1" }, 201);
    const out = await repos.create("user-42", { from: "template" });
    assert.equal(out.repo_name, "user-42");
    assert.equal(calls[0].url, BASE);
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, { repo_name: "user-42", from: "template" });
  });

  it("list returns app_repos", async () => {
    respond = () => json({ app_repos: [{ repo_name: "default", head: null }] });
    const list = await repos.list();
    assert.equal(list[0].repo_name, "default");
    assert.equal(calls[0].url, BASE);
  });

  it("delete requires confirm to equal the name", async () => {
    await assert.rejects(() => repos.delete("user-42", { confirm: "user-4" }), (err: unknown) =>
      err instanceof R402AppRepoError && err.code === "VALIDATION_FAILED" && err.field === "confirm");
    await assert.rejects(() => repos.delete("user-42", undefined as never), (err: unknown) =>
      err instanceof R402AppRepoError && err.code === "VALIDATION_FAILED");
    assert.equal(calls.length, 0);
    respond = () => json({ deleted: true, repo_name: "user-42" });
    assert.deepEqual(await repos.delete("user-42", { confirm: "user-42" }), { deleted: true, repo_name: "user-42" });
    assert.equal(calls[0].url, `${BASE}/user-42?confirm=user-42`);
    assert.equal(calls[0].method, "DELETE");
  });

  it("surfaces APP_REPO_DEFAULT_UNDELETABLE", async () => {
    respond = () => json({ code: "APP_REPO_DEFAULT_UNDELETABLE", message: "default cannot be deleted" }, 403);
    await assert.rejects(() => repos.delete("default", { confirm: "default" }), (err: unknown) =>
      err instanceof R402AppRepoError && err.code === "APP_REPO_DEFAULT_UNDELETABLE" && err.status === 403);
  });
});
