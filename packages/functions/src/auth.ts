/**
 * Legacy auth exports — throwing sentinels.
 *
 * **REMOVED in v3.0 (auth-aware-ssr).** `getUser`, `getUserId`, and
 * `getRole` are no longer working exports — they throw
 * `R402_AUTH_UNKNOWN_EXPORT` with a structured fix-it pointing at the
 * canonical `auth.*` namespace.
 *
 * ESM named imports (`import { getUser } from "@run402/functions"`)
 * can't be intercepted by a Proxy; the only way to fail loudly on
 * runtime usage is to ship a sentinel function. The `run402 doctor`
 * source scanner (public repo CLI) and the `@run402/astro` ESLint rule
 * catch the import before runtime; this file is the last line of defense
 * for code that bypasses both.
 *
 * The legacy `User` type is preserved as an alias of `Actor` for any
 * stragglers — but accessing the throwing sentinels at runtime fails.
 *
 * @see openspec/changes/auth-aware-ssr/specs/auth-sdk-namespace/spec.md
 */

import { UnknownExportError } from "./auth/errors.js";

export type User = { id: string; role: string; email: string };

/** @deprecated Removed in `@run402/functions` v3.0. Use `auth.user()` or `auth.requireUser()`. */
export function getUser(_req?: Request): never {
  throw new UnknownExportError({
    attemptedName: "getUser",
    canonicalName: "auth.user() / auth.requireUser()",
  });
}

/** @deprecated Removed in `@run402/functions` v3.0. Use `(await auth.user())?.id` or `(await auth.requireUser()).id`. */
export function getUserId(_req?: Request): never {
  throw new UnknownExportError({
    attemptedName: "getUserId",
    canonicalName: "(await auth.user())?.id",
  });
}

/** @deprecated Removed in `@run402/functions` v3.0. Use `auth.requireRole(role)`. */
export function getRole(_req?: Request): never {
  throw new UnknownExportError({
    attemptedName: "getRole",
    canonicalName: "auth.requireRole(role)",
  });
}
