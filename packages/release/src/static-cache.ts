/** Pure filename policy shared by compilers and edge-compatible consumers.
 * Inference is conservative, not proof of a content digest. Explicit mutable
 * declarations and previous-path immutability checks remain authoritative.
 */
function normalizePath(path: string): string {
  return path.split(/[?#]/, 1)[0]!.replace(/^\/+/, "");
}

export function isHtmlSitePath(path: string, contentType?: string | null): boolean {
  const type = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return /\.html?$/i.test(normalizePath(path)) ||
    type === "text/html" || type === "application/xhtml+xml";
}

export function isVersionedSiteAsset(path: string): boolean {
  const normalized = normalizePath(path);
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.startsWith("."))) return false;
  const basename = segments.at(-1) ?? "";
  if (isHtmlSitePath(basename)) return false;
  // A terminal fingerprint, optionally followed by one extension and .map.
  // Never infer immutability merely from an _astro directory or a query string.
  const stem = basename.replace(/\.[a-zA-Z][a-zA-Z0-9]*(?:\.map)?$/, "");
  const hasExtension = stem !== basename;
  const candidates = [stem];
  // '-' and '_' can themselves occur inside base64url hashes: try every
  // separator without truncating a hash that contains either character.
  for (let i = 0; i < stem.length; i++) {
    if (/[._-]/.test(stem[i]!)) candidates.push(stem.slice(i + 1));
  }
  return candidates.some((token) => {
    if (/^[0-9a-f]+$/i.test(token) && /[a-f]/i.test(token) &&
        token.length >= (hasExtension ? 8 : 12)) return true;
    // Vite/Rollup and Astro default to eight base64url characters. Require
    // mixed case or letters plus digits; ordinary words/numeric versions stay
    // mutable. Ambiguous all-lowercase custom hashes conservatively revalidate.
    return hasExtension && /^[A-Za-z0-9_-]{8}$/.test(token) &&
      ((/[A-Z]/.test(token) && /[a-z]/.test(token)) ||
       (/[A-Za-z]/.test(token) && /[0-9]/.test(token)));
  });
}
