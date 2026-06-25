import { ReleaseSpecValidationError } from "./errors.js";
import { emptyPortableReleaseState, normalizePortableReleaseState, normalizeReleaseSpec } from "./normalize.js";
import { materializeRoutes } from "./routes.js";
import {
  buildStaticManifestFromEntries,
  buildStaticManifestFromSitePaths,
  computeStaticManifestSha256,
  detectPreviousImmutableViolations,
  emptyStaticManifestMetadata,
  isDirectStaticManifestEntry,
  staticManifestEntryAssetPath,
  staticManifestPublicPathMode,
  summarizeStaticManifest,
  type StaticManifestError,
} from "./static-manifest.js";
import type {
  FunctionSpec,
  MaterializedRoutes,
  PortableFunctionEntry,
  PortableMigrationEntry,
  PortableReleaseState,
  PortableSitePath,
  PublicStaticPathSpec,
  ReleaseSpec,
  RoleGateSpec,
  RouteEntry,
  SitePublicPathsSpec,
  StaticCacheClass,
  StaticManifest,
  StaticManifestBuildEntry,
  StaticManifestFileEntry,
  StaticManifestMetadata,
  StaticManifestMethod,
} from "./types.js";
import { SUPPORTED_HTTP_METHODS } from "./types.js";

export interface MaterializeReleaseInput {
  spec: ReleaseSpec;
  concreteBase?: PortableReleaseState | null;
}

export interface MaterializedStaticManifestResult {
  manifest: StaticManifest | null;
  sha256: string | null;
  metadata: StaticManifestMetadata;
}

export function materializeRelease(input: MaterializeReleaseInput): PortableReleaseState {
  const spec = normalizeReleaseSpec(input.spec);
  const base = input.concreteBase
    ? normalizePortableReleaseState(input.concreteBase)
    : emptyPortableReleaseState();
  const out = clonePortableReleaseState(base);

  if (spec.site) {
    if ("replace" in spec.site && spec.site.replace) {
      const baseByPath = new Map(base.site.paths.map((path) => [path.path, path]));
      out.site.paths = [];
      for (const [path, ref] of Object.entries(spec.site.replace)) {
        const baseEntry = baseByPath.get(path);
        out.site.paths.push({
          path,
          content_sha256: ref.sha256,
          content_type: ref.contentType ?? inferContentType(path),
          ...(baseEntry?.content_sha256 === ref.sha256
            ? { size_bytes: baseEntry.size_bytes ?? ref.size }
            : { size_bytes: ref.size }),
        });
      }
    } else if ("patch" in spec.site && spec.site.patch) {
      const byPath = new Map(out.site.paths.map((path) => [path.path, path]));
      if (spec.site.patch.put) {
        for (const [path, ref] of Object.entries(spec.site.patch.put)) {
          byPath.set(path, {
            path,
            content_sha256: ref.sha256,
            content_type: ref.contentType ?? inferContentType(path),
            size_bytes: ref.size,
          });
        }
      }
      if (spec.site.patch.delete) {
        for (const path of spec.site.patch.delete) {
          byPath.delete(path);
        }
      }
      out.site.paths = [...byPath.values()];
    }
  }
  out.site.paths.sort((a, b) => compareAscii(a.path, b.path));

  if (spec.functions) {
    if ("replace" in spec.functions && spec.functions.replace) {
      out.functions = [];
      for (const [name, fnSpec] of Object.entries(spec.functions.replace)) {
        out.functions.push(functionEntryFromSpec(name, fnSpec));
      }
    } else if ("patch" in spec.functions && spec.functions.patch) {
      const byName = new Map(out.functions.map((fn) => [fn.name, fn]));
      if (spec.functions.patch.set) {
        for (const [name, fnSpec] of Object.entries(spec.functions.patch.set)) {
          byName.set(name, functionEntryFromSpec(name, fnSpec));
        }
      }
      if (spec.functions.patch.delete) {
        for (const name of spec.functions.patch.delete) {
          byName.delete(name);
        }
      }
      out.functions = [...byName.values()];
    }
  }
  out.functions.sort((a, b) => compareAscii(a.name, b.name));

  if (spec.secrets) {
    const set = new Set(out.secrets.keys);
    for (const key of spec.secrets.require ?? []) set.add(key);
    for (const key of spec.secrets.delete ?? []) set.delete(key);
    out.secrets.keys = [...set].sort(compareAscii);
  }

  if (spec.subdomains) {
    if (spec.subdomains.set !== undefined) {
      out.subdomains.names = [...spec.subdomains.set].sort(compareAscii);
    } else {
      const set = new Set(out.subdomains.names);
      for (const name of spec.subdomains.add ?? []) set.add(name);
      for (const name of spec.subdomains.remove ?? []) set.delete(name);
      out.subdomains.names = [...set].sort(compareAscii);
    }
  }

  if (spec.routes !== undefined && spec.routes !== null) {
    out.routes = materializeRoutes(spec.routes.replace);
  }

  if (spec.i18n !== undefined) {
    if (spec.i18n === null) {
      out.i18n = null;
    } else {
      out.i18n = {
        defaultLocale: spec.i18n.defaultLocale,
        locales: [...spec.i18n.locales],
        detect: spec.i18n.detect !== undefined
          ? [...spec.i18n.detect]
          : ["accept-language"],
        unknownLocalePolicy: spec.i18n.unknownLocalePolicy ?? "reject",
      };
    }
  }

  const builtStatic = buildStaticManifestFromPortableState(
    out.site.paths,
    out.routes,
    base.static_manifest,
    spec.site?.public_paths,
  );
  if (builtStatic.manifest) {
    const immutableViolations = detectPreviousImmutableViolations(
      base.static_manifest,
      builtStatic.manifest,
    );
    if (immutableViolations.length > 0) {
      const err = new Error("Cannot change bytes for a path previously served as immutable_versioned") as StaticManifestError;
      err.name = "StaticManifestError";
      err.code = "STATIC_IMMUTABLE_PATH_CHANGED";
      err.resource = "site";
      throw err;
    }
  }
  out.static_manifest = builtStatic.manifest;

  if (spec.database?.migrations) {
    for (const migration of spec.database.migrations) {
      const entry: PortableMigrationEntry = {
        migration_id: migration.id,
        checksum_hex: migration.checksum.toLowerCase(),
        transaction: migration.transaction === "none" ? "none" : "default",
      };
      const existing = out.migrations.find(
        (applied) =>
          applied.migration_id === entry.migration_id &&
          applied.checksum_hex.toLowerCase() === entry.checksum_hex,
      );
      if (!existing) out.migrations.push(entry);
    }
  }
  out.migrations.sort((a, b) => compareAscii(a.migration_id, b.migration_id));

  validateRouteTargets(out);
  return normalizePortableReleaseState(out);
}

export function buildStaticManifestFromPortableState(
  paths: PortableSitePath[],
  routes: MaterializedRoutes,
  baseManifest: StaticManifest | null,
  publicPathsSpec: SitePublicPathsSpec | undefined,
): MaterializedStaticManifestResult {
  const mode = resolvePublicPathMode(baseManifest, publicPathsSpec);
  const hasStaticRoutes = routes.entries.some((entry) => entry.target.type === "static");
  if (paths.length === 0 && !hasStaticRoutes && mode === "implicit") {
    return { manifest: null, sha256: null, metadata: emptyStaticManifestMetadata() };
  }
  const siteByPath = new Map(paths.map((path) => [normalizeSitePath(path.path), path]));
  const entries: StaticManifestBuildEntry[] = [];

  if (mode === "implicit") {
    const implicit = buildStaticManifestFromSitePaths(paths.map((path) => ({
      path: path.path,
      content_sha256: path.content_sha256,
      content_type: path.content_type,
      size: path.size_bytes ?? 0,
    })));
    for (const [publicPath, entry] of Object.entries(implicit.files)) {
      entries.push({
        public_path: publicPath,
        asset_path: staticManifestEntryAssetPath(publicPath, entry),
        sha256: entry.sha256,
        size: entry.size,
        content_type: entry.content_type,
        cache_class: entry.cache_class,
        authority: "implicit_file_path",
        direct: true,
        response_metadata: entry.response_metadata,
      });
    }
  } else if (publicPathsSpec?.mode === "explicit") {
    for (const [publicPath, entry] of Object.entries(publicPathsSpec.replace ?? {})) {
      entries.push(entryFromPublicPathSpec(publicPath, entry, siteByPath));
    }
  } else {
    for (const [publicPath, entry] of inheritedDirectPublicEntries(baseManifest)) {
      const assetPath = staticManifestEntryAssetPath(publicPath, entry);
      entries.push(entryFromAssetPath({
        publicPath,
        assetPath,
        siteByPath,
        cacheClass: entry.cache_class,
        authority: "explicit_public_path",
        direct: true,
        resource: `site.public_paths.inherited.${publicPath}`,
      }));
    }
  }

  for (const route of routes.entries) {
    if (route.target.type !== "static") continue;
    const existingDirect = entries.find((entry) => entry.public_path === route.pattern && entry.direct);
    if (!siteByPath.has(normalizeSitePath(route.target.file))) continue;
    const routeEntry = entryFromAssetPath({
      publicPath: route.pattern,
      assetPath: route.target.file,
      siteByPath,
      authority: "route_static_alias",
      direct: false,
      routeId: routeManifestEntryId(route),
      methods: staticRouteMethods(route),
      resource: `routes.${route.pattern}`,
    });
    if (existingDirect) {
      ensureCompatiblePublicEntries(existingDirect, routeEntry, route.pattern);
      continue;
    }
    entries.push(routeEntry);
  }

  if (entries.length === 0 && mode === "implicit") {
    return { manifest: null, sha256: null, metadata: emptyStaticManifestMetadata() };
  }
  const manifest = buildStaticManifestFromEntries(entries, {
    publicPathMode: mode,
    spaFallback: mode === "implicit" && siteByPath.has("index.html") ? "/index.html" : null,
  });
  return {
    manifest,
    sha256: computeStaticManifestSha256(manifest),
    metadata: summarizeStaticManifest(manifest),
  };
}

function clonePortableReleaseState(base: PortableReleaseState): PortableReleaseState {
  return {
    ...base,
    site: { paths: base.site.paths.map((path) => ({ ...path })) },
    static_manifest: base.static_manifest ? JSON.parse(JSON.stringify(base.static_manifest)) as StaticManifest : null,
    functions: base.functions.map((fn) => {
      const cloned: PortableFunctionEntry = {
        name: fn.name,
        code_hash: fn.code_hash,
        runtime: fn.runtime,
        timeout_seconds: fn.timeout_seconds,
        memory_mb: fn.memory_mb,
        schedule: fn.schedule,
        deps: [...fn.deps],
        require_auth: fn.require_auth,
        require_role: fn.require_role ? cloneRoleGate(fn.require_role) : null,
      };
      if (fn.class) cloned.class = fn.class;
      if (fn.capabilities) cloned.capabilities = [...fn.capabilities];
      return cloned;
    }),
    secrets: { keys: [...base.secrets.keys] },
    subdomains: { names: [...base.subdomains.names] },
    routes: {
      manifest_sha256: base.routes.manifest_sha256,
      entries: base.routes.entries.map((entry) => JSON.parse(JSON.stringify(entry)) as RouteEntry),
    },
    migrations: base.migrations.map((migration) => ({ ...migration })),
    i18n: base.i18n
      ? {
          defaultLocale: base.i18n.defaultLocale,
          locales: [...base.i18n.locales],
          detect: [...base.i18n.detect],
          unknownLocalePolicy: base.i18n.unknownLocalePolicy,
        }
      : null,
  };
}

function functionEntryFromSpec(name: string, spec: FunctionSpec): PortableFunctionEntry {
  return {
    name,
    code_hash: spec.source?.sha256 ?? "",
    runtime: spec.runtime,
    timeout_seconds: spec.config?.timeoutSeconds ?? 10,
    memory_mb: spec.config?.memoryMb ?? 128,
    schedule: spec.schedule ?? null,
    deps: spec.deps ?? [],
    require_auth: spec.requireAuth === true,
    require_role: spec.requireRole ? cloneRoleGate(spec.requireRole) : null,
    ...(spec.class ? { class: spec.class } : {}),
    ...(spec.capabilities ? { capabilities: [...spec.capabilities].sort(compareAscii) } : {}),
  };
}

function cloneRoleGate(gate: RoleGateSpec): RoleGateSpec {
  return {
    ...gate,
    allowed: [...gate.allowed],
  };
}

function validateRouteTargets(materialized: PortableReleaseState): void {
  const functionNames = new Set(materialized.functions.map((fn) => fn.name));
  const staticPaths = new Set(materialized.site.paths.map((entry) => normalizeSitePath(entry.path)));
  const missing = materialized.routes.entries.flatMap((entry) => {
    if (entry.target.type === "function") {
      return functionNames.has(entry.target.name)
        ? []
        : [`${entry.pattern} -> function ${entry.target.name}`];
    }
    return staticPaths.has(normalizeSitePath(entry.target.file))
      ? []
      : [`${entry.pattern} -> static file ${entry.target.file}`];
  });
  if (missing.length === 0) return;
  throw new ReleaseSpecValidationError(
    "routes",
    `route targets missing after materialization: ${missing.join(", ")}`,
    { missing_route_targets: missing },
  );
}

function resolvePublicPathMode(
  baseManifest: StaticManifest | null,
  publicPathsSpec: SitePublicPathsSpec | undefined,
): "implicit" | "explicit" {
  if (publicPathsSpec?.mode === "implicit") return "implicit";
  if (publicPathsSpec?.mode === "explicit") return "explicit";
  return staticManifestPublicPathMode(baseManifest);
}

function inheritedDirectPublicEntries(
  baseManifest: StaticManifest | null,
): Array<[string, StaticManifestFileEntry]> {
  if (staticManifestPublicPathMode(baseManifest) !== "explicit" || !baseManifest) return [];
  return Object.entries(baseManifest.files)
    .filter(([, entry]) => isDirectStaticManifestEntry(entry))
    .sort((a, b) => compareAscii(a[0], b[0]));
}

function entryFromPublicPathSpec(
  publicPath: string,
  spec: PublicStaticPathSpec,
  siteByPath: Map<string, PortableSitePath>,
): StaticManifestBuildEntry {
  return entryFromAssetPath({
    publicPath,
    assetPath: spec.asset,
    siteByPath,
    cacheClass: spec.cache_class,
    authority: "explicit_public_path",
    direct: true,
    resource: `site.public_paths.replace.${publicPath}`,
  });
}

function entryFromAssetPath(input: {
  publicPath: string;
  assetPath: string;
  siteByPath: Map<string, PortableSitePath>;
  cacheClass?: StaticCacheClass | null;
  authority: StaticManifestBuildEntry["authority"];
  direct: boolean;
  routeId?: string;
  methods?: StaticManifestMethod[];
  resource: string;
}): StaticManifestBuildEntry {
  const normalizedAsset = normalizeSitePath(input.assetPath);
  const asset = input.siteByPath.get(normalizedAsset);
  if (!asset) {
    throw new ReleaseSpecValidationError(
      input.resource,
      `public static path references missing asset '${input.assetPath}'`,
      { asset: input.assetPath },
    );
  }
  return {
    public_path: input.publicPath,
    asset_path: normalizedAsset,
    sha256: asset.content_sha256,
    size: asset.size_bytes ?? 0,
    content_type: asset.content_type,
    cache_class: input.cacheClass ?? null,
    authority: input.authority,
    direct: input.direct,
    ...(input.routeId ? { route_id: input.routeId } : {}),
    ...(input.methods ? { methods: input.methods } : {}),
  };
}

function ensureCompatiblePublicEntries(
  direct: StaticManifestBuildEntry,
  routeOnly: StaticManifestBuildEntry,
  publicPath: string,
): void {
  const same =
    direct.asset_path === routeOnly.asset_path &&
    direct.sha256 === routeOnly.sha256 &&
    direct.size === routeOnly.size &&
    (direct.content_type ?? null) === (routeOnly.content_type ?? null) &&
    (direct.cache_class ?? null) === (routeOnly.cache_class ?? null);
  if (same) return;
  throw new ReleaseSpecValidationError(
    "site.public_paths",
    `conflicting direct public path and static alias for ${publicPath}`,
    {
      public_path: publicPath,
      direct_asset: direct.asset_path,
      route_asset: routeOnly.asset_path,
    },
  );
}

function routeManifestEntryId(entry: RouteEntry): string {
  return `${entry.pattern}:${effectiveRouteMethods(entry.methods).join(",")}`;
}

function staticRouteMethods(entry: RouteEntry): StaticManifestMethod[] {
  const methods = effectiveRouteMethods(entry.methods).filter(
    (method): method is StaticManifestMethod => method === "GET" || method === "HEAD",
  );
  return methods.length === 0 ? ["GET", "HEAD"] : methods;
}

function effectiveRouteMethods(methods: RouteEntry["methods"]): string[] {
  return methods ?? [...SUPPORTED_HTTP_METHODS];
}

function normalizeSitePath(path: string): string {
  return path.replace(/^\/+/, "");
}

function inferContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".xml")) return "application/xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".woff")) return "font/woff";
  if (lower.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
