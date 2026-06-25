/**
 * `auth.fetch` URL validation.
 *
 * Synchronous before-network checks: the URL is rejected (sync throw)
 * before any network I/O if it's not safely same-origin. The set of
 * rejected shapes is enumerated by the spec — we mirror it verbatim:
 *
 *   - Cross-origin absolute URLs
 *   - URLs with embedded credentials (`http://user:pass@host/...`)
 *   - Non-HTTP(S) schemes (`javascript:`, `data:`, `file:`, etc.)
 *   - Protocol-relative URLs (`//evil.example/...`)
 *   - Subdomain-spoof patterns (`https://app.run402.app.evil.example/...`)
 *   - Port-mismatch against the current request origin
 *
 * Same-origin normalisation: scheme, host, and default-port comparisons
 * use `URL.origin`, which strips `:80` for http and `:443` for https.
 *
 * @see openspec/changes/auth-aware-ssr/specs/auth-sdk-namespace/spec.md
 */

export interface UrlValidationContext {
  requestOrigin: string;
}

export type UrlValidationResult =
  | { ok: true; normalized: URL }
  | { ok: false; reason: string };

const SAFE_SCHEMES = new Set(["http:", "https:"]);

export function validateAuthFetchInput(
  input: RequestInfo | URL,
  ctx: UrlValidationContext,
): UrlValidationResult {
  // Reject Request objects with cross-origin url. We don't accept Request
  // here because `auth.fetch` is the canonical surface for same-origin
  // SSR fetches; the Request escape hatch could carry headers / credentials
  // / redirect modes that bypass our policy.
  if (typeof input === "object" && input !== null && "url" in input && typeof input.url === "string") {
    // Caller passed a Request — extract the URL string and run it
    // through the same validation. Same with URL object.
    return validateAuthFetchInput(input.url, ctx);
  }
  if (input instanceof URL) {
    return validateAuthFetchInput(input.toString(), ctx);
  }
  if (typeof input !== "string") {
    return { ok: false, reason: "URL must be a string, URL, or Request" };
  }

  const raw = input;
  if (raw.length === 0) {
    return { ok: false, reason: "URL is empty" };
  }

  // Protocol-relative reject — `//host/path` resolves to the current
  // origin's scheme, but a server-side fetch has no implicit origin
  // when there's no document; the spec treats it as a smell.
  if (raw.startsWith("//")) {
    return { ok: false, reason: "protocol-relative URLs are not allowed" };
  }

  // Path-only / relative URLs (no scheme) are the happy path. We resolve
  // them against the request origin and let the URL constructor reject
  // any structural garbage.
  if (!/^[a-z][a-z0-9+\-.]*:/i.test(raw)) {
    let absolute: URL;
    try {
      absolute = new URL(raw, ctx.requestOrigin);
    } catch {
      return { ok: false, reason: "invalid relative URL" };
    }
    return { ok: true, normalized: absolute };
  }

  // Absolute URL — parse and validate.
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid absolute URL" };
  }

  if (!SAFE_SCHEMES.has(url.protocol)) {
    return { ok: false, reason: `scheme ${url.protocol} is not http(s)` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "URL contains embedded credentials" };
  }
  if (url.origin !== ctx.requestOrigin) {
    // Subdomain-spoof guard: even if the host string contains the
    // expected hostname as a substring (e.g.
    // `app.run402.app.evil.example`), URL.origin compares the full
    // host+port+scheme, so this is correct.
    return { ok: false, reason: "cross-origin URLs are not allowed" };
  }

  return { ok: true, normalized: url };
}
