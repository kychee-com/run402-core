import { PORTABLE_RELEASE_STATE_VERSION } from "./versions.js";
import { canonicalizeStaticManifest } from "./static-manifest.js";
import type { FunctionTriggerSpec, PortableReleaseState, ReleaseSpec } from "./types.js";
import { validateReleaseSpec } from "./validate.js";

export function normalizeReleaseSpec(spec: ReleaseSpec): ReleaseSpec {
  validateReleaseSpec(spec);
  const out: ReleaseSpec = { project: spec.project };
  if (spec.idempotency_key !== undefined) out.idempotency_key = spec.idempotency_key;
  if (spec.base !== undefined) out.base = spec.base;
  if (spec.database !== undefined) out.database = spec.database;
  if (spec.secrets !== undefined) out.secrets = spec.secrets;
  if (spec.functions !== undefined) out.functions = spec.functions;
  if (spec.site !== undefined) out.site = spec.site;
  if (spec.subdomains !== undefined) out.subdomains = spec.subdomains;
  if (spec.routes !== undefined) out.routes = spec.routes;
  if (spec.checks !== undefined) out.checks = spec.checks;
  if (spec.assets !== undefined) out.assets = spec.assets;
  if (spec.i18n !== undefined) out.i18n = spec.i18n;
  return deepClone(out);
}

export function normalizePortableManifest(spec: ReleaseSpec): Omit<ReleaseSpec, "project" | "idempotency_key" | "base"> {
  const normalized = normalizeReleaseSpec(spec);
  const {
    project: _project,
    idempotency_key: _idempotencyKey,
    base: _base,
    ...portable
  } = normalized;
  return portable;
}

export function emptyPortableReleaseState(): PortableReleaseState {
  return {
    state_version: PORTABLE_RELEASE_STATE_VERSION,
    site: { paths: [] },
    static_manifest: null,
    functions: [],
    secrets: { keys: [] },
    subdomains: { names: [] },
    routes: { manifest_sha256: null, entries: [] },
    migrations: [],
    i18n: null,
  };
}

export function normalizePortableReleaseState(state: PortableReleaseState): PortableReleaseState {
  if (state.state_version !== PORTABLE_RELEASE_STATE_VERSION) {
    throw new Error(`Unsupported PortableReleaseState version: ${String(state.state_version)}`);
  }
  return {
    state_version: PORTABLE_RELEASE_STATE_VERSION,
    site: {
      paths: [...state.site.paths]
        .map((path) => ({ ...path }))
        .sort((a, b) => compareAscii(a.path, b.path)),
    },
    static_manifest: state.static_manifest ? canonicalizeStaticManifest(state.static_manifest) : null,
    functions: [...state.functions]
      .map((fn) => {
        const triggers = normalizeFunctionTriggers(fn.triggers ?? []);
        const normalized = {
          name: fn.name,
          code_hash: fn.code_hash,
          runtime: fn.runtime,
          timeout_seconds: fn.timeout_seconds,
          memory_mb: fn.memory_mb,
          schedule: fn.schedule,
          deps: [...fn.deps].sort(compareAscii),
          require_auth: fn.require_auth,
          require_role: fn.require_role
            ? { ...fn.require_role, allowed: [...fn.require_role.allowed].sort(compareAscii) }
            : null,
        } as typeof fn;
        if (triggers.length > 0) normalized.triggers = triggers;
        if (fn.class) normalized.class = fn.class;
        if (fn.capabilities) normalized.capabilities = [...fn.capabilities].sort(compareAscii);
        return normalized;
      })
      .sort((a, b) => compareAscii(a.name, b.name)),
    secrets: { keys: [...state.secrets.keys].sort(compareAscii) },
    subdomains: { names: [...state.subdomains.names].sort(compareAscii) },
    routes: {
      manifest_sha256: state.routes.manifest_sha256,
      entries: [...state.routes.entries].map((entry) => deepClone(entry)),
    },
    migrations: [...state.migrations]
      .map((migration) => ({ ...migration, checksum_hex: migration.checksum_hex.toLowerCase() }))
      .sort((a, b) => compareAscii(a.migration_id, b.migration_id)),
    i18n: state.i18n
      ? {
          defaultLocale: state.i18n.defaultLocale,
          locales: [...state.i18n.locales],
          detect: [...state.i18n.detect],
          unknownLocalePolicy: state.i18n.unknownLocalePolicy,
        }
      : null,
  };
}

export function normalizeFunctionTriggers(triggers: readonly FunctionTriggerSpec[] = []): FunctionTriggerSpec[] {
  return [...triggers]
    .map((trigger) => ({
      id: trigger.id,
      type: "schedule" as const,
      cron: trigger.cron,
      timezone: trigger.timezone ?? "UTC",
      misfire_policy: trigger.misfire_policy ?? "skip",
      overlap_policy: trigger.overlap_policy ?? "allow",
      run: {
        event_type: trigger.run.event_type,
        payload: trigger.run.payload ?? {},
        ...(trigger.run.retry !== undefined ? { retry: deepClone(trigger.run.retry) as Record<string, unknown> } : {}),
        ...(trigger.run.expires_after_seconds !== undefined
          ? { expires_after_seconds: trigger.run.expires_after_seconds }
          : {}),
      },
    }))
    .sort((a, b) => compareAscii(a.id, b.id));
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
