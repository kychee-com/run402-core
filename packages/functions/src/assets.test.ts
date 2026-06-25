import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

mock.module("./config.js", {
  namedExports: {
    config: {
      API_BASE: "https://test.run402.com",
      PROJECT_ID: "prj_test",
      SERVICE_KEY: "sk_test",
    },
  },
});

const { assets } = await import("./assets.js");

const STUB_REF = {
  key: "images/avatar.png",
  sha256: "abc123",
  size_bytes: 4,
  content_type: "image/png",
  visibility: "public",
  immutable: true,
  url: "https://cdn.run402.com/images/avatar.png",
  immutable_url: "https://cdn.run402.com/images/avatar.png@abc123",
  cdn_url: null,
  cdn_immutable_url: null,
  sri: null,
  etag: "abc123",
  content_digest: "sha256-abc123",
};

describe("assets.put — gateway path and auth", () => {
  let capturedUrl = "";
  let capturedOpts: RequestInit = {};

  beforeEach(() => {
    capturedUrl = "";
    capturedOpts = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      capturedUrl = url;
      capturedOpts = opts;
      return new Response(JSON.stringify(STUB_REF), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  it("posts to /apply/v1/service-asset-put with service credentials", async () => {
    await assets.put("images/avatar.png", new Uint8Array([1, 2, 3, 4]));

    assert.equal(capturedUrl, "https://test.run402.com/apply/v1/service-asset-put");
    assert.equal(capturedOpts.method, "POST");
    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk_test");
  });

  it("sets x-run402-asset-key header to the key argument", async () => {
    await assets.put("images/avatar.png", new Uint8Array([1, 2, 3, 4]));

    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers["x-run402-asset-key"], "images/avatar.png");
  });

  it("defaults visibility to public and immutable to true", async () => {
    await assets.put("images/avatar.png", new Uint8Array([1, 2, 3, 4]));

    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers["x-run402-asset-visibility"], "public");
    assert.equal(headers["x-run402-asset-immutable"], "true");
  });

  it("forwards explicit visibility and immutable options", async () => {
    await assets.put("data/secret.bin", new Uint8Array([1, 2, 3, 4]), {
      visibility: "private",
      immutable: false,
    });

    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers["x-run402-asset-visibility"], "private");
    assert.equal(headers["x-run402-asset-immutable"], "false");
  });

  it("guesses Content-Type from key extension", async () => {
    await assets.put("styles/main.css", new Uint8Array([46, 99, 108, 115]));

    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "text/css; charset=utf-8");
  });

  it("uses explicit contentType option over guessed extension", async () => {
    await assets.put("data/blob", new Uint8Array([1, 2, 3, 4]), {
      contentType: "application/msgpack",
    });

    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/msgpack");
  });

  it("sends raw binary body (not JSON)", async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    await assets.put("file.bin", bytes);

    assert.ok(capturedOpts.body instanceof ArrayBuffer, "body must be ArrayBuffer (binary)");
    assert.notEqual(typeof capturedOpts.body, "string", "body must not be stringified");
  });

  it("accepts a string source — encodes to UTF-8 bytes", async () => {
    await assets.put("hello.txt", "hello");

    assert.ok(capturedOpts.body instanceof ArrayBuffer);
    const decoded = new TextDecoder().decode(capturedOpts.body as ArrayBuffer);
    assert.equal(decoded, "hello");
  });

  it("returns a widened AssetRef with camelCase aliases", async () => {
    const ref = await assets.put("images/avatar.png", new Uint8Array([1, 2, 3, 4]));

    assert.equal(ref.key, "images/avatar.png");
    assert.equal(ref.immutableUrl, STUB_REF.immutable_url);
    assert.equal(ref.contentType, STUB_REF.content_type);
    assert.equal(ref.size, STUB_REF.size_bytes);
    assert.equal(ref.contentSha256, STUB_REF.sha256);
  });
});

describe("assets.put — validation", () => {
  it("throws for empty key", async () => {
    await assert.rejects(
      async () => { await assets.put("", new Uint8Array([1])); },
      /key must be a non-empty string/,
    );
  });

  it("throws for empty source bytes", async () => {
    await assert.rejects(
      async () => { await assets.put("file.bin", new Uint8Array([])); },
      /bytes must be non-empty/,
    );
  });

  it("throws for object source with both content and bytes", async () => {
    await assert.rejects(
      async () => {
        await assets.put("f.bin", { content: "hi", bytes: new Uint8Array([1]) });
      },
      /provide exactly one of/,
    );
  });

  it("throws on non-ok response and preserves error detail", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ code: "STORAGE_QUOTA_EXCEEDED", message: "over limit" }), {
        status: 402,
      }),
    );
    await assert.rejects(
      async () => { await assets.put("f.bin", new Uint8Array([1])); },
      /Asset put failed \(402\): STORAGE_QUOTA_EXCEEDED: over limit/,
    );
  });
});

describe("assets.put — v1.49 image-variant fields", () => {
  const IMAGE_REF = {
    ...STUB_REF,
    width_px: 4032,
    height_px: 3024,
    blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
    variant_spec_version: "v1",
    display_url: "https://cdn.run402.com/images/avatar.png",
    display_immutable_url: "https://cdn.run402.com/images/avatar-abc123.png",
    variants: {
      thumb: {
        kind: "thumb",
        format: "webp",
        width_px: 320,
        height_px: 240,
        sha256: "thumb_sha",
        url: "https://cdn.run402.com/images/avatar-abc123-v1-thumb-thumb_sha.webp",
        immutable_url: "https://cdn.run402.com/images/avatar-abc123-v1-thumb-thumb_sha.webp",
        cdn_url: null,
        cdn_immutable_url: null,
      },
      medium: {
        kind: "medium",
        format: "webp",
        width_px: 800,
        height_px: 600,
        sha256: "medium_sha",
        url: "https://cdn.run402.com/images/avatar-abc123-v1-medium-medium_sha.webp",
        immutable_url: "https://cdn.run402.com/images/avatar-abc123-v1-medium-medium_sha.webp",
        cdn_url: null,
        cdn_immutable_url: null,
      },
      large: {
        kind: "large",
        format: "webp",
        width_px: 1920,
        height_px: 1440,
        sha256: "large_sha",
        url: "https://cdn.run402.com/images/avatar-abc123-v1-large-large_sha.webp",
        immutable_url: "https://cdn.run402.com/images/avatar-abc123-v1-large-large_sha.webp",
        cdn_url: null,
        cdn_immutable_url: null,
      },
    },
  };

  it("widens image-intrinsic fields from the gateway response", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify(IMAGE_REF), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const ref = await assets.put("images/avatar.png", new Uint8Array([1, 2, 3, 4]));

    assert.equal(ref.width_px, 4032);
    assert.equal(ref.height_px, 3024);
    assert.equal(ref.blurhash, "LEHV6nWB2yk8pyo0adR*.7kCMdnj");
    assert.equal(ref.variant_spec_version, "v1");
    assert.equal(ref.display_url, "https://cdn.run402.com/images/avatar.png");
  });

  it("widens the variants map keyed by kind", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify(IMAGE_REF), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const ref = await assets.put("images/avatar.png", new Uint8Array([1, 2, 3, 4]));

    assert.ok(ref.variants, "variants should be present for image sources");
    assert.equal(ref.variants?.thumb?.width_px, 320);
    assert.equal(ref.variants?.medium?.width_px, 800);
    assert.equal(ref.variants?.large?.width_px, 1920);
    assert.equal(ref.variants?.thumb?.format, "webp");
    assert.equal(ref.variants?.thumb?.sha256, "thumb_sha");
    assert.equal(ref.variants?.thumb?.url?.includes("v1-thumb-thumb_sha.webp"), true);
  });

  it("widens HEIC sources with display_jpeg variant", async () => {
    const HEIC_REF = {
      ...IMAGE_REF,
      content_type: "image/heic",
      variants: {
        ...IMAGE_REF.variants,
        display_jpeg: {
          kind: "display_jpeg",
          format: "jpeg",
          width_px: 4032,
          height_px: 3024,
          sha256: "display_sha",
          url: "https://cdn.run402.com/images/avatar-abc123-v1-display_jpeg-display_sha.jpg",
          immutable_url: "https://cdn.run402.com/images/avatar-abc123-v1-display_jpeg-display_sha.jpg",
          cdn_url: null,
          cdn_immutable_url: null,
        },
      },
      display_url: "https://cdn.run402.com/images/avatar-abc123-v1-display_jpeg-display_sha.jpg",
    };
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify(HEIC_REF), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const ref = await assets.put("images/photo.heic", new Uint8Array([1, 2, 3]));

    assert.equal(ref.content_type, "image/heic", "source bytes preserved as HEIC");
    assert.equal(ref.variants?.display_jpeg?.format, "jpeg");
    assert.notEqual(ref.display_url, ref.cdn_url, "display_url should diverge from cdn_url for HEIC");
    assert.ok(ref.display_url?.endsWith(".jpg"), "display_url should point to JPEG");
  });

  it("omits image-intrinsic fields for non-image AssetRefs (back-compat)", async () => {
    // Non-image response: gateway returns AssetRef without width_px/variants/etc.
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify(STUB_REF), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const ref = await assets.put("data.bin", new Uint8Array([1, 2, 3]));

    assert.equal(ref.width_px, undefined, "non-image must not have width_px");
    assert.equal(ref.height_px, undefined);
    assert.equal(ref.blurhash, undefined);
    assert.equal(ref.variants, undefined);
    assert.equal(ref.display_url, undefined);
  });
});

// ---------------------------------------------------------------------------
// v1.50 — metadata + exifPolicy on put, and the new assets.list
// ---------------------------------------------------------------------------

describe("assets.put — v1.50 metadata + exifPolicy", () => {
  let capturedOpts: RequestInit = {};
  beforeEach(() => {
    capturedOpts = {};
    mock.method(globalThis, "fetch", async (_url: string, opts: RequestInit) => {
      capturedOpts = opts;
      return new Response(JSON.stringify(STUB_REF), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  it("always sends x-run402-asset-exif-policy header (default 'keep')", async () => {
    await assets.put("a.png", new Uint8Array([1, 2, 3]));
    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers["x-run402-asset-exif-policy"], "keep");
  });

  it("sends x-run402-asset-exif-policy: strip when opts.exifPolicy='strip'", async () => {
    await assets.put("photo.jpg", new Uint8Array([1, 2, 3]), { exifPolicy: "strip" });
    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers["x-run402-asset-exif-policy"], "strip");
  });

  it("rejects invalid exifPolicy values BEFORE making the HTTP call", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    await assert.rejects(
      async () => {
        await assets.put("a.png", new Uint8Array([1]), {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          exifPolicy: "redact" as any,
        });
      },
      /INVALID_EXIF_POLICY/,
    );
    assert.equal(fetchCalled, false, "must validate before HTTP");
  });

  it("encodes metadata as URL-safe base64 JSON in the x-run402-asset-metadata header", async () => {
    await assets.put("a.png", new Uint8Array([1]), {
      metadata: { filename: "hero.jpg", uploaded_by: "user_a", tags: ["banner", "hero"] },
    });
    const headers = capturedOpts.headers as Record<string, string>;
    assert.ok(headers["x-run402-asset-metadata"], "header should be set");
    // Round-trip: base64url-decode → JSON.parse → equal to supplied metadata.
    const decoded = JSON.parse(
      Buffer.from(headers["x-run402-asset-metadata"]!, "base64url").toString("utf8"),
    );
    assert.deepEqual(decoded, {
      filename: "hero.jpg",
      uploaded_by: "user_a",
      tags: ["banner", "hero"],
    });
  });

  it("omits the metadata header when opts.metadata is absent", async () => {
    await assets.put("a.png", new Uint8Array([1]));
    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers["x-run402-asset-metadata"], undefined);
  });

  it("rejects nested-object metadata BEFORE the HTTP call", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    await assert.rejects(
      async () => {
        await assets.put("a.png", new Uint8Array([1]), {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          metadata: { exif: { camera: "Canon" } } as any,
        });
      },
      /INVALID_ASSET_METADATA.*nested/,
    );
    assert.equal(fetchCalled, false);
  });

  it("rejects metadata exceeding the 4 KB cap BEFORE the HTTP call", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    await assert.rejects(
      async () => {
        await assets.put("a.png", new Uint8Array([1]), {
          metadata: { overflow: "x".repeat(5000) },
        });
      },
      /INVALID_ASSET_METADATA.*4096/,
    );
    assert.equal(fetchCalled, false);
  });

  it("widens v1.50 AssetRef fields from the response", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          ...STUB_REF,
          metadata: { filename: "hero.jpg" },
          image_format: "jpeg",
          image_info: { has_alpha: false, color_space: "srgb" },
          image_exif: { camera_make: "Canon" },
          image_exif_policy: "keep",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const ref = await assets.put("hero.jpg", new Uint8Array([1, 2, 3]));
    assert.deepEqual(ref.metadata, { filename: "hero.jpg" });
    assert.equal(ref.image_format, "jpeg");
    assert.deepEqual(ref.image_info, { has_alpha: false, color_space: "srgb" });
    assert.deepEqual(ref.image_exif, { camera_make: "Canon" });
    assert.equal(ref.image_exif_policy, "keep");
  });
});

describe("assets.list — v1.50 sort + filter + new row fields", () => {
  let capturedUrl = "";
  beforeEach(() => {
    capturedUrl = "";
    mock.method(globalThis, "fetch", async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          blobs: [
            {
              key: "images/hero.jpg",
              size_bytes: 12345,
              content_type: "image/jpeg",
              sha256: "abc",
              visibility: "public",
              immutable_suffix: "abc12345",
              created_at: "2026-05-19T10:00:00.000Z",
              updated_at: "2026-05-19T10:00:00.000Z",
              metadata: { filename: "hero.jpg" },
              width_px: 1920,
              height_px: 1080,
              blurhash: "LEHV6n",
              image_format: "jpeg",
              image_info: { color_space: "srgb" },
              image_exif: { camera_make: "Canon" },
              image_exif_policy: "keep",
            },
          ],
          next_cursor: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
  });

  it("issues GET /storage/v1/blobs with apikey auth", async () => {
    const result = await assets.list({ prefix: "images/" });
    assert.match(capturedUrl, /\/storage\/v1\/blobs\?/);
    assert.match(capturedUrl, /prefix=images%2F/);
    assert.equal(result.blobs.length, 1);
    assert.equal(result.next_cursor, null);
  });

  it("propagates sort + filter to query params", async () => {
    await assets.list({
      sort: "createdAt:desc",
      filter: {
        uploaded_by: "user_a",
        tag: "hero",
        format: "jpeg",
        is_image: true,
        min_width: 1920,
      },
    });
    assert.match(capturedUrl, /sort=createdAt%3Adesc/);
    assert.match(capturedUrl, /filter\.uploaded_by=user_a/);
    assert.match(capturedUrl, /filter\.tag=hero/);
    assert.match(capturedUrl, /filter\.format=jpeg/);
    assert.match(capturedUrl, /filter\.is_image=true/);
    assert.match(capturedUrl, /filter\.min_width=1920/);
  });

  it("omits sort when default (key:asc)", async () => {
    await assets.list({});
    assert.doesNotMatch(capturedUrl, /sort=/);
  });

  it("returns top-level v1.50 fields on each row", async () => {
    const result = await assets.list({});
    const row = result.blobs[0]!;
    assert.deepEqual(row.metadata, { filename: "hero.jpg" });
    assert.equal(row.width_px, 1920);
    assert.equal(row.height_px, 1080);
    assert.equal(row.blurhash, "LEHV6n");
    assert.equal(row.image_format, "jpeg");
    assert.deepEqual(row.image_info, { color_space: "srgb" });
    assert.deepEqual(row.image_exif, { camera_make: "Canon" });
    assert.equal(row.image_exif_policy, "keep");
  });

  it("rejects unknown filter keys BEFORE the HTTP call", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async () => { await assets.list({ filter: { customField: "x" } as any }); },
      /INVALID_FILTER_KEY/,
    );
    assert.equal(fetchCalled, false);
  });

  it("rejects invalid sort values BEFORE the HTTP call", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async () => { await assets.list({ sort: "size:asc" as any }); },
      /INVALID_SORT/,
    );
    assert.equal(fetchCalled, false);
  });

  it("rejects non-boolean filter.is_image BEFORE the HTTP call", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async () => { await assets.list({ filter: { is_image: "yes" } as any }); },
      /INVALID_FILTER_VALUE/,
    );
    assert.equal(fetchCalled, false);
  });

  it("rejects non-integer dimension filters BEFORE the HTTP call", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    await assert.rejects(
      async () => { await assets.list({ filter: { min_width: 1.5 } }); },
      /INVALID_FILTER_VALUE/,
    );
    assert.equal(fetchCalled, false);
  });

  it("propagates cursor for pagination", async () => {
    await assets.list({ cursor: "abc-cursor" });
    assert.match(capturedUrl, /cursor=abc-cursor/);
  });
});

describe("assets.fromRef — re-hydrate a stored AssetRef", () => {
  it("rehydrates a v1.49+ shape with variants + camelCase aliases", () => {
    const stored = {
      key: "images/hero.heic",
      sha256: "src-sha-9999",
      size_bytes: 1024000,
      content_type: "image/heic",
      visibility: "public",
      immutable: true,
      url: "https://cdn.run402.com/images/hero.heic",
      immutable_url: "https://cdn.run402.com/images/hero.heic@src-sha-9999",
      cdn_url: "https://kychon.com/_blob/images/hero.heic",
      cdn_immutable_url: "https://kychon.com/_blob/images/hero.heic@src-sha-9999",
      sri: null,
      etag: "src-sha-9999",
      content_digest: "sha256-src-sha-9999",
      width_px: 4032,
      height_px: 3024,
      blurhash: "LKO2:N%2Tw=^]~RBVZRi};RPxuwH",
      variant_spec_version: "v1",
      display_url: "https://cdn.run402.com/images/hero-display.jpg",
      display_immutable_url: "https://cdn.run402.com/images/hero-display.jpg@var-sha-jpeg",
      variants: {
        thumb: {
          kind: "thumb",
          format: "webp",
          width_px: 320,
          height_px: 240,
          sha256: "thumb-sha",
          url: "https://cdn.run402.com/thumb.webp",
          immutable_url: "https://cdn.run402.com/thumb.webp@thumb-sha",
          cdn_url: "https://kychon.com/_blob/thumb.webp",
          cdn_immutable_url: "https://kychon.com/_blob/thumb.webp@thumb-sha",
        },
        large: {
          kind: "large",
          format: "webp",
          width_px: 1920,
          height_px: 1440,
          sha256: "large-sha",
          url: "https://cdn.run402.com/large.webp",
          immutable_url: "https://cdn.run402.com/large.webp@large-sha",
          cdn_url: "https://kychon.com/_blob/large.webp",
          cdn_immutable_url: "https://kychon.com/_blob/large.webp@large-sha",
        },
        display_jpeg: {
          kind: "display_jpeg",
          format: "jpeg",
          width_px: 4032,
          height_px: 3024,
          sha256: "var-sha-jpeg",
          url: "https://cdn.run402.com/display.jpg",
          immutable_url: "https://cdn.run402.com/display.jpg@var-sha-jpeg",
          cdn_url: "https://kychon.com/_blob/display.jpg",
          cdn_immutable_url: "https://kychon.com/_blob/display.jpg@var-sha-jpeg",
        },
      },
    };
    const ref = assets.fromRef(stored);
    // Snake + camel are both populated.
    assert.equal(ref.sha256, "src-sha-9999");
    assert.equal(ref.cdn_url, "https://kychon.com/_blob/images/hero.heic");
    assert.equal(ref.cdnUrl, "https://kychon.com/_blob/images/hero.heic");
    assert.equal(ref.contentType, "image/heic");
    assert.equal(ref.contentSha256, "src-sha-9999");
    // v1.49 fields preserved.
    assert.equal(ref.width_px, 4032);
    assert.equal(ref.blurhash, "LKO2:N%2Tw=^]~RBVZRi};RPxuwH");
    assert.equal(ref.display_url, "https://cdn.run402.com/images/hero-display.jpg");
    // Variants typed correctly.
    assert.equal(ref.variants?.thumb?.format, "webp");
    assert.equal(ref.variants?.large?.width_px, 1920);
    assert.equal(ref.variants?.display_jpeg?.format, "jpeg");
  });

  it("tolerates a pre-v1.49 stored shape (no variants/intrinsics)", () => {
    const stored = {
      key: "data/manifest.json",
      sha256: "manifest-sha",
      size_bytes: 256,
      content_type: "application/json",
      visibility: "public",
      immutable: false,
      url: "https://cdn.run402.com/data/manifest.json",
      immutable_url: null,
      cdn_url: null,
      cdn_immutable_url: null,
      sri: null,
      etag: "manifest-sha",
      content_digest: "sha256-manifest-sha",
    };
    const ref = assets.fromRef(stored);
    assert.equal(ref.sha256, "manifest-sha");
    assert.equal(ref.immutableUrl, null);
    // Optional fields absent (not synthesized to undefined-as-property).
    assert.equal(Object.prototype.hasOwnProperty.call(ref, "variants"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ref, "width_px"), false);
  });

  it("throws on null / undefined / array inputs", () => {
    assert.throws(() => assets.fromRef(null), /null\/undefined/);
    assert.throws(() => assets.fromRef(undefined), /null\/undefined/);
    assert.throws(() => assets.fromRef([] as unknown), /plain object/);
    assert.throws(() => assets.fromRef("not an object" as unknown), /plain object/);
  });
});
