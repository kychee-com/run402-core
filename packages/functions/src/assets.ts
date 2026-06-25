/**
 * `assets` namespace — in-function blob upload via the unified-apply substrate.
 *
 * Calls `POST /apply/v1/service-asset-put` with service-key auth. The gateway
 * runs the same activation sub-transaction the wallet-auth apply hero uses
 * (`promoteStagedAssetSlice`), so visibility, immutable-URL retention, and
 * per-unique-hash storage billing all behave identically to deploy-time
 * `r.project(id).apply({ assets: { put: [...] } })`.
 *
 * Pre-v1.48 the runtime called `/storage/v1/uploads*`; that substrate was
 * removed in the unified-apply migration. This namespace is the v2.1+
 * in-function replacement.
 */

import { config } from "./config.js";

export type AssetVisibility = "public" | "private";

export interface AssetPutSource {
  content?: string;
  bytes?: Uint8Array;
}

export type AssetPutSourceInput = string | Uint8Array | AssetPutSource;

export interface AssetPutOptions {
  contentType?: string;
  visibility?: AssetVisibility;
  /**
   * When `true` (default), the returned `immutableUrl` is content-addressed
   * and the underlying `internal.asset_versions` row is retained per the
   * project's tier. When `false`, only the mutable `url` is meaningful;
   * `immutableUrl` is null.
   */
  immutable?: boolean;
  /**
   * v1.50 — caller-provided per-key metadata persisted to
   * `internal.blobs.metadata`. Flat object; values must be string, number,
   * boolean, or string[]. Nested objects are rejected. Serialized size cap:
   * 4 KB. Validated client-side before any HTTP call so bad shapes surface
   * as `Error` ("INVALID_ASSET_METADATA: …") rather than HTTP 400 round-trips.
   *
   * Last-write-wins on re-upload — omitting `metadata` on a subsequent put
   * for the same key clears any previously-stored metadata.
   */
  metadata?: Record<string, string | number | boolean | string[]>;
  /**
   * v1.50 — EXIF policy applied to the indexed `image_exif` JSONB on
   * `internal.blobs`. `'keep'` (default) stores the full EXIF object;
   * `'strip'` keeps only the allowlist (camera_make / camera_model /
   * lens_model / exposure_time / f_number / iso / focal_length /
   * datetime_*). Original CAS bytes are NEVER mutated under either policy.
   */
  exifPolicy?: "keep" | "strip";
}

/**
 * Resolved asset reference. Wire shape matches the AssetRef the SDK's
 * `r.project(id).apply` and `r.assets.put` return, so HTML rendered against
 * these URLs is byte-identical to the deploy-time path.
 *
 * Mutable URL: `url` (and `cdnUrl`).
 * Immutable URL: `immutableUrl` (and `cdnImmutableUrl`) — content-hashed
 * suffix, suitable for SRI + indefinite caching.
 *
 * snake_case (`immutable_url`, `size_bytes`, `content_type`) and camelCase
 * (`immutableUrl`, `size`, `contentType`) aliases are both emitted so
 * existing callers and the SDK's surface keep working without translation.
 */
/**
 * Per-variant entry returned in `AssetRef.variants` (gateway v1.49+).
 *
 * Each generated image variant carries its serving URL, immutable
 * (sha-suffixed) URL, display-oriented dimensions, format, and its own
 * content SHA. URLs are `null` when the source is private (`visibility:
 * "private"`).
 */
export interface AssetVariant {
  kind: "thumb" | "medium" | "large" | "display_jpeg";
  format: "webp" | "jpeg";
  width_px: number;
  height_px: number;
  /** Hex sha256 of the encoded variant bytes. */
  sha256: string;
  url: string | null;
  immutable_url: string | null;
  cdn_url: string | null;
  cdn_immutable_url: string | null;
}

/** v1.50 — descriptive image-intrinsic info. All fields optional; populated
 *  only for image uploads (image_format !== null). */
export interface ImageInfo {
  has_alpha?: boolean;
  color_space?: string;
  animated?: boolean;
  frame_count?: number;
  bit_depth?: number;
  orientation?: number;
}

export interface AssetRef {
  key: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  visibility: AssetVisibility;
  immutable: boolean;
  url: string | null;
  immutable_url: string | null;
  cdn_url: string | null;
  cdn_immutable_url: string | null;
  sri: string | null;
  etag: string;
  content_digest: string;
  // camelCase aliases for SDK parity.
  immutableUrl: string | null;
  cdnUrl: string | null;
  cdnImmutableUrl: string | null;
  size: number;
  contentType: string;
  contentSha256: string;

  // ─── v1.50 — caller metadata + image intrinsics ──────────────────────────
  // Flat top-level fields matching `internal.blobs` column names. The
  // variants change already shipped `width_px` / `height_px` / `blurhash`
  // as top-level; v1.50 adds the remaining image-intrinsic + caller-metadata
  // columns alongside in the same flat shape.

  /** Caller-provided per-key metadata (`internal.blobs.metadata` JSONB).
   *  `null` when no metadata was supplied at the last upload. */
  metadata?: Record<string, string | number | boolean | string[]> | null;
  /** Bare image format (`internal.blobs.image_format`). One of `'jpeg' |
   *  'png' | 'webp' | 'avif' | 'tiff' | 'svg' | 'bmp' | 'heic'`. `null` for
   *  non-images. */
  image_format?: string | null;
  /** Descriptive image-intrinsic fields (`internal.blobs.image_info`). */
  image_info?: ImageInfo | null;
  /** Extracted EXIF tags (`internal.blobs.image_exif`). Snake_case keys,
   *  policy-filtered per `image_exif_policy`. `null` when the image has no
   *  EXIF or no allowlisted tags survived `'strip'`. */
  image_exif?: Record<string, unknown> | null;
  /** Which EXIF policy was applied at upload (`'keep' | 'strip' | null`).
   *  `null` for non-images. */
  image_exif_policy?: "keep" | "strip" | null;

  // ─── v1.49 — image-intrinsic fields ───────────────────────────────────────
  // All optional; populated only when the gateway encoded the source through
  // the image-variant pipeline (image MIMEs above 320×320). Non-images and
  // smaller sources keep these as `undefined`.

  /** Display-oriented width (post-EXIF rotate). */
  width_px?: number;
  /** Display-oriented height (post-EXIF rotate). */
  height_px?: number;
  /** ~30-byte LQIP placeholder. Decode client-side with the `blurhash` npm
   *  package; render before the real image is ready to eliminate CLS. */
  blurhash?: string;
  /** Pins the URLs and variant identities to a specific encoder generation.
   *  Bumping this string (gateway-side) produces new variant URLs without
   *  invalidating older ones. */
  variant_spec_version?: string;
  /** Browser-displayable URL. For jpeg/png/webp/avif sources this equals
   *  `cdn_url`. For HEIC/HEIF sources, this points at the JPEG `display_jpeg`
   *  variant so `<img src>` renders correctly without app-side branching. */
  display_url?: string | null;
  display_immutable_url?: string | null;
  /** Keyed by variant kind. `thumb`/`medium`/`large` are present for any
   *  successfully-encoded image source ≥ 320×320. `display_jpeg` is present
   *  only for HEIC/HEIF sources. */
  variants?: {
    thumb?: AssetVariant;
    medium?: AssetVariant;
    large?: AssetVariant;
    display_jpeg?: AssetVariant;
  };

  // ─── v1.54 — asset shape-contract fields ─────────────────────────────────
  // Both populated atomically at upload time when the gateway encoder runs.
  // Surfaced on the AssetRef so consumers (`<Run402Image>`, `r.assets.fromRef`)
  // can render placeholders + apply schema-filtered strict-mode without an
  // extra DB roundtrip.

  /** Pre-decoded PNG data URL (~600-1200 bytes typical at 16×16) computed
   *  once at upload time from the canonical pinned BlurHash decoder.
   *  `<Run402Image>` emits this as the placeholder `background-image` so
   *  render is pure-local (no SSR-time decode). `null` when the decoder
   *  failed on otherwise-valid input (rare). */
  blurhash_data_url?: string | null;
  /** Semver shape-contract stamp recording the highest contract this row's
   *  fields satisfy. `null` for partial-shape rows (e.g., missing
   *  `display_jpeg` on a HEIC source). Read by `<Run402Image>` strict-mode
   *  when configured with `imageDefaults.strict: { onSchema: ">=v1.49" }` to
   *  skip legacy rows. */
  asset_schema?: "v1.49" | "v1.50" | "v1.54" | null;
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  pdf: "application/pdf",
  zip: "application/zip",
  tgz: "application/gzip",
  gz: "application/gzip",
};

function guessContentType(key: string): string {
  const dot = key.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = key.slice(dot + 1).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

function normalizeSource(source: AssetPutSourceInput): Uint8Array {
  if (typeof source === "string") {
    return new TextEncoder().encode(source);
  }
  if (source instanceof Uint8Array) {
    return source;
  }
  if (source && typeof source === "object") {
    if (source.content !== undefined && source.bytes !== undefined) {
      throw new Error(
        "assets.put: provide exactly one of `content` or `bytes` in source",
      );
    }
    if (typeof source.content === "string") {
      return new TextEncoder().encode(source.content);
    }
    if (source.bytes instanceof Uint8Array) {
      return source.bytes;
    }
  }
  throw new Error(
    "assets.put: source must be a string, Uint8Array, or { content | bytes } object",
  );
}

function widenAssetRef(raw: Record<string, unknown>): AssetRef {
  const url = (raw.url as string | null) ?? null;
  const immutableUrl = (raw.immutable_url as string | null) ?? null;
  const cdnUrl = (raw.cdn_url as string | null) ?? null;
  const cdnImmutableUrl = (raw.cdn_immutable_url as string | null) ?? null;

  // v1.49 image-intrinsic pass-through. Only attach the fields if the gateway
  // returned them (image MIMEs ≥ 320×320). For non-images the gateway omits
  // them entirely; we mirror that by not adding `undefined` slots either.
  const widthPx = typeof raw.width_px === "number" ? raw.width_px : undefined;
  const heightPx = typeof raw.height_px === "number" ? raw.height_px : undefined;
  const blurhash = typeof raw.blurhash === "string" ? raw.blurhash : undefined;
  const variantSpecVersion = typeof raw.variant_spec_version === "string"
    ? raw.variant_spec_version
    : undefined;
  const displayUrl = typeof raw.display_url === "string"
    ? raw.display_url
    : raw.display_url === null
      ? null
      : undefined;
  const displayImmutableUrl = typeof raw.display_immutable_url === "string"
    ? raw.display_immutable_url
    : raw.display_immutable_url === null
      ? null
      : undefined;

  let variants: AssetRef["variants"];
  if (raw.variants && typeof raw.variants === "object" && !Array.isArray(raw.variants)) {
    const src = raw.variants as Record<string, unknown>;
    variants = {};
    for (const kind of ["thumb", "medium", "large", "display_jpeg"] as const) {
      const v = src[kind];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const variantRaw = v as Record<string, unknown>;
        variants[kind] = {
          kind,
          format: (variantRaw.format === "jpeg" ? "jpeg" : "webp"),
          width_px: Number(variantRaw.width_px ?? 0),
          height_px: Number(variantRaw.height_px ?? 0),
          sha256: String(variantRaw.sha256 ?? ""),
          url: (variantRaw.url as string | null) ?? null,
          immutable_url: (variantRaw.immutable_url as string | null) ?? null,
          cdn_url: (variantRaw.cdn_url as string | null) ?? null,
          cdn_immutable_url: (variantRaw.cdn_immutable_url as string | null) ?? null,
        };
      }
    }
    if (Object.keys(variants).length === 0) variants = undefined;
  }

  return {
    key: String(raw.key ?? ""),
    sha256: String(raw.sha256 ?? ""),
    size_bytes: Number(raw.size_bytes ?? 0),
    content_type: String(raw.content_type ?? "application/octet-stream"),
    visibility: (raw.visibility as AssetVisibility) ?? "public",
    immutable: raw.immutable === true,
    url,
    immutable_url: immutableUrl,
    cdn_url: cdnUrl,
    cdn_immutable_url: cdnImmutableUrl,
    sri: (raw.sri as string | null) ?? null,
    etag: String(raw.etag ?? ""),
    content_digest: String(raw.content_digest ?? ""),
    immutableUrl,
    cdnUrl,
    cdnImmutableUrl,
    size: Number(raw.size_bytes ?? 0),
    contentType: String(raw.content_type ?? "application/octet-stream"),
    contentSha256: String(raw.sha256 ?? ""),
    ...(widthPx !== undefined ? { width_px: widthPx } : {}),
    ...(heightPx !== undefined ? { height_px: heightPx } : {}),
    ...(blurhash !== undefined ? { blurhash } : {}),
    ...(variantSpecVersion !== undefined ? { variant_spec_version: variantSpecVersion } : {}),
    ...(displayUrl !== undefined ? { display_url: displayUrl } : {}),
    ...(displayImmutableUrl !== undefined ? { display_immutable_url: displayImmutableUrl } : {}),
    ...(variants !== undefined ? { variants } : {}),
    // v1.50 — pass-through caller metadata + image intrinsics. Gateway
    // omits non-image fields entirely for non-image uploads; we mirror
    // that by emitting `undefined` (omitted slot) rather than `null` for
    // fields the gateway didn't return. The exception is `metadata`,
    // which the gateway always returns (null if the caller supplied none).
    ...(raw.metadata !== undefined
      ? { metadata: raw.metadata as AssetRef["metadata"] }
      : {}),
    ...(raw.image_format !== undefined
      ? { image_format: raw.image_format as AssetRef["image_format"] }
      : {}),
    ...(raw.image_info !== undefined
      ? { image_info: raw.image_info as AssetRef["image_info"] }
      : {}),
    ...(raw.image_exif !== undefined
      ? { image_exif: raw.image_exif as AssetRef["image_exif"] }
      : {}),
    ...(raw.image_exif_policy !== undefined
      ? { image_exif_policy: raw.image_exif_policy as AssetRef["image_exif_policy"] }
      : {}),
    // v1.54 — asset shape-contract fields. Same omit-when-undefined pattern
    // as the v1.50 fields: legacy AssetRefs (uploaded before v1.54) won't
    // carry these and `<Run402Image>`'s schema-filter + placeholder logic
    // correctly handles their absence (falls through to `cdn_url` only +
    // skips strict-mode per the schema filter).
    ...(raw.blurhash_data_url !== undefined
      ? { blurhash_data_url: raw.blurhash_data_url as AssetRef["blurhash_data_url"] }
      : {}),
    ...(raw.asset_schema !== undefined
      ? { asset_schema: raw.asset_schema as AssetRef["asset_schema"] }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// v1.50 — SDK-side metadata + exifPolicy validation. Mirrors the gateway's
// `services/asset-metadata-validation.ts` exactly so client errors surface
// before the HTTP call. We deliberately do NOT import from the gateway —
// `@run402/functions` is bundled into deployed function code and must have
// zero gateway-package dependencies.
// ---------------------------------------------------------------------------

const METADATA_MAX_BYTES = 4096;

/** Validate caller-supplied metadata. Throws Error("INVALID_ASSET_METADATA: …")
 *  on any rule violation. */
function validateMetadataClientSide(
  input: Record<string, unknown>,
): Record<string, string | number | boolean | string[]> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("INVALID_ASSET_METADATA: metadata must be a flat JSON object");
  }
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("INVALID_ASSET_METADATA: metadata keys must be non-empty strings");
    }
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== "string") {
          throw new Error(
            `INVALID_ASSET_METADATA: metadata.${key}[${i}] must be a string (no mixed-type arrays)`,
          );
        }
      }
      out[key] = value as string[];
      continue;
    }
    if (typeof value === "object") {
      throw new Error(
        `INVALID_ASSET_METADATA: metadata.${key} must not be a nested object (flat shape only)`,
      );
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error(
          `INVALID_ASSET_METADATA: metadata.${key} number value must be finite`,
        );
      }
      out[key] = value;
      continue;
    }
    if (typeof value === "string" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    throw new Error(
      `INVALID_ASSET_METADATA: metadata.${key} has unsupported value type ${typeof value}`,
    );
  }
  const serialized = JSON.stringify(out);
  // Use UTF-8 byte length (matches the gateway-side Buffer.byteLength check).
  const byteLength =
    typeof TextEncoder !== "undefined"
      ? new TextEncoder().encode(serialized).byteLength
      : serialized.length;
  if (byteLength > METADATA_MAX_BYTES) {
    throw new Error(
      `INVALID_ASSET_METADATA: serialized size ${byteLength} bytes exceeds the ${METADATA_MAX_BYTES}-byte cap`,
    );
  }
  return out;
}

/** Validate the exifPolicy enum value. Throws on invalid input. */
function validateExifPolicyClientSide(input: unknown): "keep" | "strip" {
  if (input === undefined || input === null || input === "") return "keep";
  if (input === "keep" || input === "strip") return input;
  throw new Error(
    `INVALID_EXIF_POLICY: exifPolicy must be 'keep' or 'strip'; got ${JSON.stringify(input)}`,
  );
}

/** Encode a validated metadata object as the URL-safe base64 UTF-8 JSON
 *  header value the gateway expects on `x-run402-asset-metadata`. */
function encodeMetadataHeader(
  metadata: Record<string, string | number | boolean | string[]>,
): string {
  const json = JSON.stringify(metadata);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(json, "utf8").toString("base64url");
  }
  // Browser / older Node fallback (Node 22 has Buffer.base64url natively).
  // btoa works on Latin-1; use TextEncoder + manual base64url for safety.
  const utf8 = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < utf8.byteLength; i++) binary += String.fromCharCode(utf8[i]!);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as {
      code?: string;
      error?: string;
      message?: string;
    };
    const msg = parsed.message || parsed.error || text;
    return parsed.code ? `${parsed.code}: ${msg}` : msg;
  } catch {
    return text;
  }
}

export const assets = {
  /**
   * Upload bytes to the project's blob store and return the resolved AssetRef.
   *
   * Defaults: `visibility: "public"`, `immutable: true`. The mutable `url`
   * always serves the latest bytes for the key; the `immutableUrl` is
   * content-hashed and stable for SRI / long-TTL caching.
   *
   * The gateway runs the same activation sub-transaction the wallet apply
   * hero uses, so quota enforcement (402 on storage-tier overage),
   * per-unique-hash storage billing, and immutable-URL retention all match
   * deploy-time behavior.
   */
  async put(
    key: string,
    source: AssetPutSourceInput,
    opts: AssetPutOptions = {},
  ): Promise<AssetRef> {
    if (typeof key !== "string" || key === "") {
      throw new Error("assets.put: key must be a non-empty string");
    }
    const bytes = normalizeSource(source);
    if (bytes.byteLength === 0) {
      throw new Error("assets.put: bytes must be non-empty");
    }
    const contentType = opts.contentType ?? guessContentType(key);
    const visibility: AssetVisibility = opts.visibility ?? "public";
    const immutable = opts.immutable ?? true;

    // v1.50 — validate metadata + exifPolicy BEFORE the HTTP round-trip so
    // bad client shapes surface as JS Errors with INVALID_ASSET_METADATA /
    // INVALID_EXIF_POLICY codes rather than gateway 400s. Mirrors the
    // gateway-side validator's rules exactly.
    const validatedMetadata =
      opts.metadata !== undefined
        ? validateMetadataClientSide(opts.metadata)
        : null;
    const exifPolicy = validateExifPolicyClientSide(opts.exifPolicy);

    // Slice into a fresh ArrayBuffer so the fetch body is a `BufferSource`
    // (Uint8Array<ArrayBufferLike> stopped matching the DOM `BodyInit` union
    // when TS 5.7 made TypedArrays generic over their backing buffer).
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;

    const headers: Record<string, string> = {
      Authorization: "Bearer " + config.SERVICE_KEY,
      "Content-Type": contentType,
      "x-run402-asset-key": key,
      "x-run402-asset-visibility": visibility,
      "x-run402-asset-immutable": immutable ? "true" : "false",
      // Always send exif-policy; gateway defaults to 'keep' when absent,
      // but explicit value makes the wire shape self-documenting.
      "x-run402-asset-exif-policy": exifPolicy,
    };
    if (validatedMetadata !== null) {
      headers["x-run402-asset-metadata"] = encodeMetadataHeader(validatedMetadata);
    }

    const res = await fetch(config.API_BASE + "/apply/v1/service-asset-put", {
      method: "POST",
      headers,
      body: buf,
    });
    if (!res.ok) {
      throw new Error(
        "Asset put failed (" + res.status + "): " + (await readErrorMessage(res)),
      );
    }
    const raw = (await res.json()) as Record<string, unknown>;
    return widenAssetRef(raw);
  },

  /**
   * v1.50 — list blobs in the project's storage namespace.
   *
   * Defaults: `sort: 'key:asc'`, `limit: 100`. Supply `filter` to constrain
   * results to indexed predicates (uploadedBy, tag, format, isImage, plus
   * dimension ranges). Unknown filter keys throw before the HTTP call.
   *
   * Returns the rows in the order specified by `sort`, with a `next_cursor`
   * for keyset pagination. The cursor is opaque — pass it back as-is on the
   * next call.
   */
  async list(opts: AssetsListOptions = {}): Promise<AssetsListResult> {
    const validatedFilter = validateListFilterClientSide(opts.filter);
    const validatedSort = validateListSortClientSide(opts.sort);

    const params = new URLSearchParams();
    if (opts.prefix !== undefined && opts.prefix !== "") {
      params.set("prefix", opts.prefix);
    }
    if (opts.limit !== undefined) {
      params.set("limit", String(opts.limit));
    }
    if (opts.cursor !== undefined && opts.cursor !== "") {
      params.set("cursor", opts.cursor);
    }
    if (validatedSort !== "key:asc") {
      // Default omitted; explicit non-default sent.
      params.set("sort", validatedSort);
    }
    if (validatedFilter) {
      for (const [k, v] of Object.entries(validatedFilter)) {
        if (v === undefined) continue;
        params.set(`filter.${k}`, typeof v === "boolean" ? String(v) : String(v));
      }
    }

    const url =
      config.API_BASE +
      "/storage/v1/blobs" +
      (params.toString() ? "?" + params.toString() : "");
    const res = await fetch(url, {
      method: "GET",
      headers: { apikey: config.SERVICE_KEY },
    });
    if (!res.ok) {
      throw new Error(
        "Asset list failed (" + res.status + "): " + (await readErrorMessage(res)),
      );
    }
    const json = (await res.json()) as {
      blobs: Array<Record<string, unknown>>;
      next_cursor: string | null;
    };
    return {
      blobs: json.blobs.map((row) => ({
        key: String(row.key),
        size_bytes: Number(row.size_bytes ?? 0),
        content_type: (row.content_type as string | null) ?? null,
        sha256: (row.sha256 as string | null) ?? null,
        visibility: (row.visibility as AssetVisibility) ?? "public",
        immutable_suffix: (row.immutable_suffix as string | null) ?? null,
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        metadata:
          (row.metadata as Record<string, string | number | boolean | string[]> | null) ??
          null,
        width_px: (row.width_px as number | null) ?? null,
        height_px: (row.height_px as number | null) ?? null,
        blurhash: (row.blurhash as string | null) ?? null,
        image_format: (row.image_format as string | null) ?? null,
        image_info: (row.image_info as ImageInfo | null) ?? null,
        image_exif: (row.image_exif as Record<string, unknown> | null) ?? null,
        image_exif_policy:
          (row.image_exif_policy as "keep" | "strip" | null) ?? null,
      })),
      next_cursor: json.next_cursor,
    };
  },

  /**
   * Re-hydrate a stored `AssetRef` value (e.g., a JSONB column read out of
   * the user's database) back into the SDK's `AssetRef` shape — including
   * the camelCase aliases (`cdnUrl`, `immutableUrl`, etc.) and the variant
   * map. Purely local — no network round-trip — so it's safe to call in
   * SSR-cacheable render paths.
   *
   * Why this exists: the recommended way to persist an asset reference is
   * to store the full `AssetRef` returned by `r.assets.put(...)` as a
   * JSONB column. That preserves the variant SHAs + immutable URLs that
   * the gateway computed at upload time (these can't be re-derived from
   * `(source_sha, key)` alone — each variant has its own content hash).
   * Reading the column back gives you a `Record<string, unknown>`; pass
   * it to `fromRef()` to get a typed `AssetRef` you can hand to
   * `<Image>` / `<picture>` / `<img>` directly.
   *
   * Tolerant of partial inputs: if the persisted blob predates v1.49
   * variants, the returned `AssetRef.variants` / `width_px` / etc. fields
   * are simply absent (not synthesized). Mutable URLs (`url`, `cdn_url`)
   * remain stable across re-uploads to the same key; immutable URLs
   * remain stable across re-uploads of the same bytes — so persisted
   * `AssetRef` blobs continue serving correctly even if the underlying
   * key's bytes change.
   *
   * Throws when the input is null/undefined or not a plain object.
   *
   * @example
   *   // Postgres row: SELECT hero_asset FROM sections WHERE id = $1
   *   const row = await db.query(...);
   *   const hero = r.assets.fromRef(row.hero_asset);
   *   // hero.cdnUrl, hero.variants.large?.cdn_url, hero.blurhash, ...
   */
  fromRef(raw: unknown): AssetRef {
    if (raw === null || raw === undefined) {
      throw new Error("assets.fromRef: input is null/undefined");
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("assets.fromRef: input must be a plain object");
    }
    return widenAssetRef(raw as Record<string, unknown>);
  },
};

// ---------------------------------------------------------------------------
// v1.50 — assets.list types + validators.
// ---------------------------------------------------------------------------

export type AssetsListSort = "key:asc" | "createdAt:asc" | "createdAt:desc";

export interface AssetsListFilter {
  uploaded_by?: string;
  tag?: string;
  format?: string;
  is_image?: boolean;
  min_width?: number;
  max_width?: number;
  min_height?: number;
  max_height?: number;
}

const ASSETS_LIST_FILTER_KEYS = [
  "uploaded_by",
  "tag",
  "format",
  "is_image",
  "min_width",
  "max_width",
  "min_height",
  "max_height",
] as const;

export interface AssetsListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
  sort?: AssetsListSort;
  filter?: AssetsListFilter;
}

export interface AssetListRow {
  key: string;
  size_bytes: number;
  content_type: string | null;
  sha256: string | null;
  visibility: AssetVisibility;
  immutable_suffix: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, string | number | boolean | string[]> | null;
  width_px: number | null;
  height_px: number | null;
  blurhash: string | null;
  image_format: string | null;
  image_info: ImageInfo | null;
  image_exif: Record<string, unknown> | null;
  image_exif_policy: "keep" | "strip" | null;
}

export interface AssetsListResult {
  blobs: AssetListRow[];
  next_cursor: string | null;
}

function validateListSortClientSide(input: unknown): AssetsListSort {
  if (input === undefined || input === null || input === "") return "key:asc";
  if (input === "key:asc" || input === "createdAt:asc" || input === "createdAt:desc") {
    return input;
  }
  throw new Error(
    `INVALID_SORT: sort must be one of 'key:asc' | 'createdAt:asc' | 'createdAt:desc'; got ${JSON.stringify(input)}`,
  );
}

function validateListFilterClientSide(
  input: AssetsListFilter | undefined,
): AssetsListFilter | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("INVALID_FILTER_KEY: filter must be an object");
  }
  const allowed = new Set(ASSETS_LIST_FILTER_KEYS as readonly string[]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new Error(
        `INVALID_FILTER_KEY: unknown filter key '${key}'. Allowed: ${ASSETS_LIST_FILTER_KEYS.join(", ")}`,
      );
    }
  }
  // Type narrowing for each key (mirrors the gateway-side parser).
  if (input.is_image !== undefined && typeof input.is_image !== "boolean") {
    throw new Error("INVALID_FILTER_VALUE: filter.is_image must be a boolean");
  }
  for (const dimKey of ["min_width", "max_width", "min_height", "max_height"] as const) {
    const v = input[dimKey];
    if (v !== undefined) {
      if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
        throw new Error(
          `INVALID_FILTER_VALUE: filter.${dimKey} must be a non-negative integer; got ${JSON.stringify(v)}`,
        );
      }
    }
  }
  return input;
}
