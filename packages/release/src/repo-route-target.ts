import { ReleaseSpecValidationError } from "./errors.js";
import type { RepoRouteTarget, RoleGateSpec } from "./types.js";

/** An app repo name: lowercase, 1-64 chars, never ending in `.git`. */
export const APP_REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ROLE_GATE_KEYS = ["table", "idColumn", "roleColumn", "allowed", "cacheTtl", "onDeny", "signInPath"] as const;
const REPO_TARGET_KEYS = ["type", "repo", "path", "requireAuth", "requireRole"] as const;

export function isValidAppRepoName(name: unknown): name is string {
  return typeof name === "string" && APP_REPO_NAME.test(name) && !name.endsWith(".git");
}

/**
 * Shape check for a `requireRole` block. Shared by `FunctionSpec.requireRole`
 * and repo route targets, so both are validated by the same rule.
 */
export function validateRoleGate(gate: unknown, resource: string): asserts gate is RoleGateSpec {
  if (!isRecord(gate)) throw invalid(resource, "requireRole must be an object");
  for (const key of Object.keys(gate)) {
    if (!(ROLE_GATE_KEYS as readonly string[]).includes(key)) {
      throw invalid(`${resource}.${key}`, `unknown key '${key}' (allowed: ${ROLE_GATE_KEYS.join(", ")})`);
    }
  }
  for (const key of ["table", "idColumn", "roleColumn"] as const) {
    const value = gate[key];
    if (typeof value !== "string" || !SQL_IDENTIFIER.test(value)) {
      throw invalid(`${resource}.${key}`, `${key} must be a SQL identifier`);
    }
  }
  const allowed = gate.allowed;
  if (!Array.isArray(allowed)) throw invalid(`${resource}.allowed`, `${resource}.allowed must be an array`);
  for (let i = 0; i < allowed.length; i++) {
    if (typeof allowed[i] !== "string") {
      throw invalid(`${resource}.allowed[${i}]`, `${resource}.allowed entries must be valid strings`);
    }
  }
}

/**
 * Validate and canonicalize a `{ type: "repo" }` route target.
 *
 * The path rule depends on the route pattern's kind:
 * - PREFIX pattern (`/content/*`): `path` is an optional directory prefix in
 *   the repo ("" = the repo root). The part of the request path matched by
 *   `*` is appended to it to name the file. Canonical form ends with `/`
 *   when non-empty.
 * - EXACT pattern (`/robots.txt`): `path` is required and names the file
 *   itself; it must not end with `/`.
 *
 * Either way `path` is repo-relative: no leading `/`, no empty, `.`, `..` or
 * `.git` segments, no backslashes, query strings or fragments. The repo's
 * existence is not checked here.
 */
export function canonicalizeRepoRouteTarget(
  raw: Record<string, unknown>,
  kind: "exact" | "prefix",
  resource: string,
): RepoRouteTarget {
  for (const key of Object.keys(raw)) {
    if (!(REPO_TARGET_KEYS as readonly string[]).includes(key)) {
      throw invalid(`${resource}.${key}`, `unknown key '${key}' (allowed: ${REPO_TARGET_KEYS.join(", ")})`);
    }
  }
  if (!isValidAppRepoName(raw.repo)) {
    throw invalid(
      `${resource}.repo`,
      "repo route target.repo must be an app repo name: 1-64 characters of a-z, 0-9, '.', '_' or '-', starting with a letter or digit, not ending in .git",
    );
  }
  const path = canonicalizeRepoPath(raw.path, kind, `${resource}.path`);
  if (raw.requireAuth !== undefined && typeof raw.requireAuth !== "boolean") {
    throw invalid(`${resource}.requireAuth`, "requireAuth must be a boolean");
  }
  let requireRole: RoleGateSpec | undefined;
  if (raw.requireRole !== undefined && raw.requireRole !== null) {
    validateRoleGate(raw.requireRole, `${resource}.requireRole`);
    requireRole = canonicalRoleGate(raw.requireRole);
  }
  return {
    type: "repo",
    repo: raw.repo,
    path,
    ...(raw.requireAuth === true ? { requireAuth: true } : {}),
    ...(requireRole ? { requireRole } : {}),
  };
}

function canonicalizeRepoPath(value: unknown, kind: "exact" | "prefix", resource: string): string {
  if (value === undefined || value === null || value === "") {
    if (kind === "exact") {
      throw invalid(resource, "repo route target.path is required for an exact pattern and names the file to serve");
    }
    return "";
  }
  if (typeof value !== "string") throw invalid(resource, "repo route target.path must be a string");
  if (value.startsWith("/")) throw invalid(resource, "repo route target.path must not start with /");
  if (value.includes("\\")) throw invalid(resource, "repo route target.path must use / path separators, not backslashes");
  if (value.includes("?") || value.includes("#")) {
    throw invalid(resource, "repo route target.path must not include query strings or fragments");
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw invalid(resource, "repo route target.path must not contain control characters");
  if (kind === "exact" && value.endsWith("/")) {
    throw invalid(resource, "repo route target.path must name a file for an exact pattern, not a directory");
  }
  const body = value.endsWith("/") ? value.slice(0, -1) : value;
  for (const segment of body.split("/")) {
    if (segment.length === 0) throw invalid(resource, "repo route target.path must not contain empty path segments");
    if (segment === "." || segment === "..") throw invalid(resource, "repo route target.path must not contain . or .. path segments");
    if (segment.toLowerCase() === ".git") throw invalid(resource, "repo route target.path must not contain .git path segments");
  }
  return kind === "prefix" ? `${body}/` : body;
}

function canonicalRoleGate(gate: RoleGateSpec): RoleGateSpec {
  return {
    table: gate.table,
    idColumn: gate.idColumn,
    roleColumn: gate.roleColumn,
    allowed: [...gate.allowed],
    ...(gate.cacheTtl !== undefined ? { cacheTtl: gate.cacheTtl } : {}),
    ...(gate.onDeny !== undefined ? { onDeny: gate.onDeny } : {}),
    ...(gate.signInPath !== undefined ? { signInPath: gate.signInPath } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(resource: string, message: string): ReleaseSpecValidationError {
  return new ReleaseSpecValidationError(resource, message);
}
