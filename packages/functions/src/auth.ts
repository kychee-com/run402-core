/**
 * Legacy auth exports — throwing sentinels.
 *
 * `getUser`, `getUserId`, and `getRole` are not working exports — calling
 * them throws `R402_AUTH_UNKNOWN_EXPORT` with a structured fix-it pointing
 * at the canonical `auth.*` namespace.
 *
 * ESM named imports (`import { getUser } from "@run402/functions"`)
 * can't be intercepted by a Proxy; the only way to fail loudly on
 * runtime usage is to ship a sentinel function. The `run402 doctor`
 * source scanner (public repo CLI) and the `@run402/astro` ESLint rule
 * catch the import before runtime; this file is the last line of defense
 * for code that bypasses both.
 *
 * The `User` type is preserved as an alias of `Actor` for callers that
 * still import the type — but calling the sentinel functions at runtime
 * always fails.
 */

import { UnknownExportError } from "./auth/errors.js";

export type User = { id: string; role: string; email: string };

/** @deprecated Use `auth.user()` or `auth.requireUser()` instead. */
export function getUser(_req?: Request): never {
  throw new UnknownExportError({
    attemptedName: "getUser",
    canonicalName: "auth.user() / auth.requireUser()",
  });
}

/** @deprecated Use `(await auth.user())?.id` or `(await auth.requireUser()).id` instead. */
export function getUserId(_req?: Request): never {
  throw new UnknownExportError({
    attemptedName: "getUserId",
    canonicalName: "(await auth.user())?.id",
  });
}

/** @deprecated Use `auth.requireRole(role)` instead. */
export function getRole(_req?: Request): never {
  throw new UnknownExportError({
    attemptedName: "getRole",
    canonicalName: "auth.requireRole(role)",
  });
}
