/**
 * `repo` and `repos` namespaces — the project's app repos: plain git
 * repositories the app reads and commits from inside its functions.
 *
 * ```ts
 * import { repo, repos } from "@run402/functions";
 *
 * const site = await repo.readJson("site.json");          // null until written
 * await repo.commit({ "site.json": { ...site, title } }, { message: "Rename the site" });
 *
 * await repos.create("user-42", { from: "template" });
 * const mine = repos.open("user-42");
 * ```
 *
 * `repo` is the `default` app repo, which always exists (it reads as an empty
 * repository until its first commit). Every other repo is created with
 * `repos.create`; opening one makes no call.
 *
 * **One request reads one commit.** Inside a request, the first read of a
 * repo resolves its head once and pins that commit in the request context;
 * every later read of that repo in the request reads the pinned commit, and a
 * commit is built on it (`base`). A successful `commit` or `revert` moves the
 * pin to the new head, so the request reads what it wrote. The next request
 * resolves the head afresh. Outside a request context (a scheduled or
 * triggered run without one) nothing is pinned: each call reads the head,
 * unless you pin with `at(commit)`.
 *
 * Every call uses the project's service key. A commit or revert also forwards
 * the request's data-plane actor token, so the platform records the verified
 * signed-in user (`Run402-Actor` trailer) and names them as author.
 *
 * **Run402 Cloud only.** On a host without the app-repo routes (Run402 Core)
 * every call throws `R402AppRepoError` with `code: "APP_REPOS_UNSUPPORTED"`.
 */

import { config } from "./config.js";
import { DATA_PLANE_ACTOR_TOKEN_HEADER, readHeader } from "./lib/project-jwt-keys.js";
import { currentAppRepoPins, getCurrentContext, type AppRepoPinSlot } from "./runtime-context.js";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface AppRepoNextAction {
  type: string;
  message?: string;
  why?: string;
  method?: string;
  path?: string;
  command?: string;
  [key: string]: unknown;
}

/** A repo summary, as `repos.list()` and `repos.create()` return it. */
export interface AppRepoSummary {
  repo_name: string;
  /** The head commit, `null` for an empty repo. */
  head: string | null;
  seq: number;
  commit_count: number;
  size_bytes: number;
  /** `size_bytes` as a decimal label, e.g. `"1.2 MB"`. */
  size: string;
  clone_url: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface AppRepoPerson {
  name: string;
  email: string;
}

export interface AppRepoCommitRecord {
  commit: string;
  parent: string | null;
  seq: number;
  author: AppRepoPerson;
  committer: AppRepoPerson;
  message: string;
  committed_at: string;
  /** Changed paths, capped at 100; `paths_total` is exact. */
  paths: string[];
  paths_total: number;
  /** The verified signed-in user who made the commit, when there was one. */
  actor_user_id: string | null;
  [key: string]: unknown;
}

export interface AppRepoLog {
  /** Newest first. */
  commits: AppRepoCommitRecord[];
  head: string | null;
  has_more: boolean;
  next_cursor: string | null;
}

export interface AppRepoLogOptions {
  /** Only commits that changed this path. */
  path?: string;
  /** 1–100, default 50. */
  limit?: number;
  /** `next_cursor` from the previous page. */
  cursor?: string;
}

export interface AppRepoTreeEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  oid: string;
}

export interface AppRepoDiffChange {
  path: string;
  status: "added" | "modified" | "deleted";
  old_oid: string | null;
  new_oid: string | null;
}

export interface AppRepoDiff {
  from: string | null;
  to: string | null;
  changes: AppRepoDiffChange[];
}

/** A JSON value `commit` writes canonically (keys sorted, two-space indent, trailing newline). */
export type AppRepoJsonValue =
  | string
  | number
  | boolean
  | null
  | AppRepoJsonValue[]
  | { [key: string]: AppRepoJsonValue };

/**
 * What a path maps to in `commit(files)`: a string (UTF-8 text), bytes, `null`
 * (delete the file), or any other JSON value (written canonically).
 */
export type AppRepoFileValue = string | Uint8Array | null | number | boolean | AppRepoJsonValue[] | { [key: string]: unknown };

export interface AppRepoCommitOptions {
  /** Default `Update <path>` for one path, `Update <n> files` otherwise. */
  message?: string;
  /** Act for someone else. Default: the signed-in user, else the app. Never changes the verified actor. */
  author?: AppRepoPerson;
  /** Land only if this is still the head (`409 APP_REPO_CONFLICT` otherwise). */
  parent?: string;
}

export interface AppRepoRevertOptions {
  /** Default `Revert "<subject>"`. */
  message?: string;
}

/** `commit` / `revert` answer: a new commit, or `{ committed: false, head }` when nothing changed. */
export type AppRepoCommitResult =
  | {
      committed: true;
      commit: string;
      parent: string | null;
      head: string;
      seq: number;
      paths: string[];
      author: AppRepoPerson;
      [key: string]: unknown;
    }
  | { committed: false; head: string | null; [key: string]: unknown };

/** Reads, history and pinning: what every handle offers. */
export interface AppRepoReader {
  readonly name: string;
  /** The file as UTF-8 text, or `null` when it is absent. */
  read(path: string): Promise<string | null>;
  /** The file's bytes, or `null` when it is absent. */
  readBytes(path: string): Promise<Uint8Array | null>;
  /** The file parsed as JSON, or `null` when it is absent. */
  readJson<T = unknown>(path: string): Promise<T | null>;
  /** The entries of a directory (the root when omitted); `[]` for an empty repo. */
  list(dir?: string): Promise<AppRepoTreeEntry[]>;
  /** The commit this request reads (resolving it if needed); `null` for an empty repo. */
  head(): Promise<string | null>;
  log(opts?: AppRepoLogOptions): Promise<AppRepoLog>;
  diff(from: string, to: string): Promise<AppRepoDiff>;
}

/** A handle on one app repo. */
export interface AppRepo extends AppRepoReader {
  commit(files: Record<string, AppRepoFileValue>, opts?: AppRepoCommitOptions): Promise<AppRepoCommitResult>;
  /** Commit the inverse of `commit`'s changes. */
  revert(commit: string, opts?: AppRepoRevertOptions): Promise<AppRepoCommitResult>;
  /** A read-only handle pinned to `commit`. */
  at(commit: string): AppRepoReader;
}

export interface AppReposCreateOptions {
  /** Copy this repo's head and history (objects are shared, not copied). */
  from?: string;
}

export interface AppReposDeleteOptions {
  /** Must equal the repo's name. */
  confirm: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * An app-repo call failed. `code` is the gateway's (`APP_REPO_NOT_FOUND`,
 * `APP_REPO_EXISTS`, `APP_REPO_CONFLICT` with
 * `details: { head, base, conflicting_paths }`, `APP_REPO_FILE_TOO_LARGE`,
 * `APP_REPO_DEFAULT_UNDELETABLE`, `QUOTA_EXCEEDED`, `VALIDATION_FAILED`, …),
 * `APP_REPOS_UNSUPPORTED` on a host without app repos (Run402 Core), a local
 * `VALIDATION_FAILED` (with `field`) for input checked before any request,
 * `APP_REPO_INVALID_JSON` when `readJson` finds a file that is not JSON, or
 * `PROJECT_ID_MISSING` outside a deployed function.
 */
export class R402AppRepoError extends Error {
  readonly code: string;
  /** HTTP status, or `null` when no request was made. */
  readonly status: number | null;
  readonly details: Record<string, unknown> | null;
  readonly next_actions: AppRepoNextAction[];
  /** Local validation failures name the offending input, e.g. `files.a.txt`. */
  readonly field: string | null;
  readonly body: unknown;

  constructor(
    code: string,
    message: string,
    fields: {
      status?: number | null;
      details?: Record<string, unknown> | null;
      next_actions?: AppRepoNextAction[];
      field?: string | null;
      body?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "R402AppRepoError";
    this.code = code;
    this.status = fields.status ?? null;
    this.details = fields.details ?? null;
    this.next_actions = fields.next_actions ?? [];
    this.field = fields.field ?? null;
    this.body = fields.body;
  }
}

function invalid(field: string, message: string): R402AppRepoError {
  return new R402AppRepoError("VALIDATION_FAILED", `app repos: ${field}: ${message}`, { field });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const DEFAULT_REPO = "default";
const COMMIT_HEADER = "x-run402-commit";
const PATH_NOT_FOUND = "APP_REPO_PATH_NOT_FOUND";

function collectionPath(): string {
  const projectId = config.PROJECT_ID;
  if (!projectId) {
    throw new R402AppRepoError(
      "PROJECT_ID_MISSING",
      "app repos: RUN402_PROJECT_ID is not set; this helper runs inside a deployed function (or set it for local runs)",
    );
  }
  return `/projects/v1/${encodeURIComponent(projectId)}/app-repos`;
}

function repoPath(name: string): string {
  return `${collectionPath()}/${encodeURIComponent(name)}`;
}

/** Each segment encoded on its own, so `/` stays a separator. A leading `/` is dropped. */
function encodeRepoPath(path: string): string {
  return path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}

/** Cloud's catch-all for an unmatched route is `404 { code: "RESOURCE_NOT_FOUND", message: "Cannot GET /…" }`; Core's has no code. */
function looksLikeMissingRoute(status: number, body: unknown): boolean {
  if (status === 405 || status === 501) return true;
  if (status !== 404) return false;
  if (!body || typeof body !== "object") return true;
  const obj = body as Record<string, unknown>;
  if (typeof obj.code !== "string") return true;
  const message = typeof obj.message === "string" ? obj.message : typeof obj.error === "string" ? obj.error : "";
  return /^Cannot (GET|POST|DELETE|PUT|PATCH) \//.test(message);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorFrom(status: number, body: unknown): R402AppRepoError {
  if (looksLikeMissingRoute(status, body)) {
    return new R402AppRepoError(
      "APP_REPOS_UNSUPPORTED",
      "app repos: this host does not serve app repos (Run402 Cloud does; Run402 Core does not)",
      { status, body },
    );
  }
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = typeof obj.code === "string" && obj.code !== "" ? obj.code : `HTTP_${status}`;
  const message =
    typeof obj.message === "string" && obj.message !== ""
      ? obj.message
      : typeof obj.error === "string" && obj.error !== ""
        ? obj.error
        : `HTTP ${status}`;
  return new R402AppRepoError(code, `app repos: ${message}`, {
    status,
    details:
      obj.details && typeof obj.details === "object" && !Array.isArray(obj.details)
        ? (obj.details as Record<string, unknown>)
        : null,
    next_actions: Array.isArray(obj.next_actions) ? (obj.next_actions as AppRepoNextAction[]) : [],
    body,
  });
}

async function send(
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: { body?: unknown; actorToken?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: "Bearer " + config.SERVICE_KEY };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.actorToken) headers[DATA_PLANE_ACTOR_TOKEN_HEADER] = opts.actorToken;
  return fetch(config.API_BASE + path, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function requestJson<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: { body?: unknown; actorToken?: string } = {},
): Promise<T> {
  const res = await send(method, path, opts);
  const body = await readBody(res);
  if (!res.ok) throw errorFrom(res.status, body);
  return body as T;
}

/** The request's data-plane actor token, when a signed-in user made it. Writes only. */
function requestActorToken(): string | undefined {
  const ctx = getCurrentContext();
  if (ctx === undefined || !ctx.active.value) return undefined;
  return readHeader(ctx.request.headers, DATA_PLANE_ACTOR_TOKEN_HEADER) || undefined;
}

// ---------------------------------------------------------------------------
// Pinning
// ---------------------------------------------------------------------------

/**
 * One read. `at` is the commit to read (`undefined`: the head). The result's
 * `commit` is the commit the read came from (`null`: an empty repo), or
 * `undefined` when the answer does not say, which pins nothing.
 */
type Read<T> = (at: string | undefined) => Promise<{ value: T; commit?: string | null }>;

/**
 * Run a read under the request's pin for `name`: from the pinned commit when
 * there is one (an empty pin answers `empty` with no call), otherwise from the
 * head, pinning the commit it came from.
 */
async function pinnedRead<T>(name: string, read: Read<T>, empty: () => T): Promise<T> {
  const pins = currentAppRepoPins();
  if (pins === undefined) return (await read(undefined)).value;
  for (;;) {
    const slot = pins.get(name);
    if (slot?.state === "pinned") {
      if (slot.commit === null) return empty();
      return (await read(slot.commit)).value;
    }
    if (slot?.state === "resolving") {
      await slot.done;
      continue;
    }
    let release!: () => void;
    const mine: AppRepoPinSlot = { state: "resolving", done: new Promise<void>((resolve) => (release = resolve)) };
    pins.set(name, mine);
    try {
      const out = await read(undefined);
      if (pins.get(name) === mine) {
        if (out.commit === undefined) pins.delete(name);
        else pins.set(name, { state: "pinned", commit: out.commit });
      }
      return out.value;
    } catch (err) {
      if (pins.get(name) === mine) pins.delete(name);
      throw err;
    } finally {
      release();
    }
  }
}

/** The request's pinned commit for `name` (waiting out a first read in flight); `undefined` when none. */
async function pinnedBase(name: string): Promise<string | undefined> {
  const pins = currentAppRepoPins();
  if (pins === undefined) return undefined;
  for (;;) {
    const slot = pins.get(name);
    if (slot?.state === "resolving") {
      await slot.done;
      continue;
    }
    return slot?.state === "pinned" && slot.commit !== null ? slot.commit : undefined;
  }
}

function movePin(name: string, head: unknown): void {
  const pins = currentAppRepoPins();
  if (pins === undefined) return;
  if (typeof head === "string" || head === null) pins.set(name, { state: "pinned", commit: head });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function requirePath(path: unknown, field: string): string {
  if (typeof path !== "string" || path.replace(/^\/+/, "") === "") throw invalid(field, "must be a non-empty path");
  return path;
}

function readFile(name: string, path: string): Read<Uint8Array | null> {
  return async (at) => {
    const res = await send("GET", withQuery(`${repoPath(name)}/files/${encodeRepoPath(path)}`, { at }));
    const commitHeader = res.headers.get(COMMIT_HEADER);
    if (res.ok) {
      const value = new Uint8Array(await res.arrayBuffer());
      return { value, ...(commitHeader ? { commit: commitHeader } : {}) };
    }
    const body = await readBody(res);
    if (res.status === 404 && body && typeof body === "object" && (body as Record<string, unknown>).code === PATH_NOT_FOUND) {
      // The header names the commit the read resolved; absent, the repo is empty.
      return { value: null, commit: commitHeader || null };
    }
    throw errorFrom(res.status, body);
  };
}

function readTree(name: string, dir: string | undefined): Read<AppRepoTreeEntry[]> {
  const clean = (dir ?? "").replace(/^\/+|\/+$/g, "");
  return async (at) => {
    const path = clean ? `${repoPath(name)}/tree/${encodeRepoPath(clean)}` : `${repoPath(name)}/tree`;
    const tree = await requestJson<{ commit: string | null; entries?: AppRepoTreeEntry[] }>("GET", withQuery(path, { at }));
    return { value: tree.commit === null ? [] : tree.entries ?? [], commit: tree.commit ?? null };
  };
}

function readHead(name: string): Read<string | null> {
  return async (at) => {
    if (at !== undefined) return { value: at }; // already pinned: no call
    const summary = await requestJson<{ head: string | null }>("GET", repoPath(name));
    const head = summary.head ?? null;
    return { value: head, commit: head };
  };
}

const decoder = new TextDecoder();

function parseJson<T>(name: string, path: string, bytes: Uint8Array | null): T | null {
  if (bytes === null) return null;
  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } catch (err) {
    throw new R402AppRepoError("APP_REPO_INVALID_JSON", `app repos: ${name}:${path} is not valid JSON (${(err as Error).message})`, {
      details: { repo_name: name, path },
    });
  }
}

function history(name: string): Pick<AppRepoReader, "log" | "diff"> {
  return {
    async log(opts: AppRepoLogOptions = {}): Promise<AppRepoLog> {
      return requestJson<AppRepoLog>(
        "GET",
        withQuery(`${repoPath(name)}/commits`, { path: opts.path, limit: opts.limit, cursor: opts.cursor }),
      );
    },
    async diff(from: string, to: string): Promise<AppRepoDiff> {
      return requestJson<AppRepoDiff>("GET", withQuery(`${repoPath(name)}/diff`, { from, to }));
    },
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function encodeFiles(files: Record<string, AppRepoFileValue>): Record<string, unknown> {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw invalid("files", "must be an object mapping paths to contents");
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(files)) {
    if (value === null) out[path] = null;
    else if (typeof value === "string") out[path] = { text: value };
    else if (value instanceof Uint8Array) {
      out[path] = { base64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
    } else if (value === undefined) throw invalid(`files.${path}`, "is undefined; pass null to delete the file");
    else out[path] = { json: value };
  }
  return out;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(field, "must be a non-empty string");
  return value;
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

function readerAt(name: string, commit: string): AppRepoReader {
  const at = <T>(read: Read<T>) => read(commit).then((out) => out.value);
  return {
    name,
    async read(path) {
      const bytes = await at(readFile(name, requirePath(path, "path")));
      return bytes === null ? null : decoder.decode(bytes);
    },
    async readBytes(path) {
      return at(readFile(name, requirePath(path, "path")));
    },
    async readJson<T = unknown>(path: string) {
      return parseJson<T>(name, path, await at(readFile(name, requirePath(path, "path"))));
    },
    async list(dir) {
      return at(readTree(name, dir));
    },
    async head() {
      return commit;
    },
    ...history(name),
  };
}

function openRepo(name: string): AppRepo {
  const bytesOf = (path: string) => pinnedRead(name, readFile(name, requirePath(path, "path")), () => null);
  return {
    name,
    async read(path) {
      const bytes = await bytesOf(path);
      return bytes === null ? null : decoder.decode(bytes);
    },
    async readBytes(path) {
      return bytesOf(path);
    },
    async readJson<T = unknown>(path: string) {
      return parseJson<T>(name, path, await bytesOf(path));
    },
    async list(dir) {
      return pinnedRead(name, readTree(name, dir), () => []);
    },
    async head() {
      return pinnedRead(name, readHead(name), () => null);
    },
    ...history(name),

    async commit(files, opts = {}) {
      const encoded = encodeFiles(files);
      const base = await pinnedBase(name);
      const result = await requestJson<AppRepoCommitResult>("POST", `${repoPath(name)}/commits`, {
        body: {
          files: encoded,
          ...(opts.message !== undefined ? { message: opts.message } : {}),
          ...(opts.author !== undefined ? { author: opts.author } : {}),
          ...(opts.parent !== undefined ? { parent: opts.parent } : {}),
          ...(base !== undefined ? { base } : {}),
        },
        actorToken: requestActorToken(),
      });
      movePin(name, result?.head);
      return result;
    },

    async revert(commit, opts = {}) {
      const target = requireId(commit, "commit");
      const base = await pinnedBase(name);
      const result = await requestJson<AppRepoCommitResult>("POST", `${repoPath(name)}/reverts`, {
        body: {
          commit: target,
          ...(opts.message !== undefined ? { message: opts.message } : {}),
          ...(base !== undefined ? { base } : {}),
        },
        actorToken: requestActorToken(),
      });
      movePin(name, result?.head);
      return result;
    },

    at(commit) {
      return readerAt(name, requireId(commit, "commit"));
    },
  };
}

/** The project's `default` app repo. It always exists; until its first commit it reads as empty. */
export const repo: AppRepo = openRepo(DEFAULT_REPO);

export const repos = {
  /** A handle on the named repo. Makes no call; a repo that does not exist fails on use with `APP_REPO_NOT_FOUND`. */
  open(name: string): AppRepo {
    return name === DEFAULT_REPO ? repo : openRepo(requireId(name, "name"));
  },

  /** Create a repo, optionally `from` another repo of the project (its head and history; objects are shared). */
  async create(name: string, opts: AppReposCreateOptions = {}): Promise<AppRepoSummary> {
    return requestJson<AppRepoSummary>("POST", collectionPath(), {
      body: { repo_name: requireId(name, "name"), ...(opts.from !== undefined ? { from: opts.from } : {}) },
    });
  },

  /** Every repo of the project; `default` is always listed. */
  async list(): Promise<AppRepoSummary[]> {
    const out = await requestJson<{ app_repos: AppRepoSummary[] }>("GET", collectionPath());
    return out.app_repos;
  },

  /** Delete a repo. `confirm` must equal its name; `default` cannot be deleted. */
  async delete(name: string, opts: AppReposDeleteOptions): Promise<{ deleted: true; repo_name: string }> {
    const repoName = requireId(name, "name");
    if (opts?.confirm !== repoName) throw invalid("confirm", `must equal the repo name ${JSON.stringify(repoName)}`);
    return requestJson<{ deleted: true; repo_name: string }>("DELETE", withQuery(repoPath(repoName), { confirm: repoName }));
  },
};
