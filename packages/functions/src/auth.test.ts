import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getUser, getUserId, getRole } from "./auth.js";
import { UnknownExportError } from "./auth/index.js";

// v3.0 (auth-aware-ssr): the legacy bare-name exports were removed. They
// now throw R402_AUTH_UNKNOWN_EXPORT with a structured fix-it pointing
// at the canonical auth.* namespace. The earlier JWT-based test suite
// was retired with the export; the replacement assertions live here.

describe("legacy bare-name auth exports — throwing sentinels", () => {
  it("getUser throws UnknownExportError with auth.user() fix-it", () => {
    assert.throws(
      () => getUser(),
      (err: unknown) => {
        assert.ok(err instanceof UnknownExportError, "throws UnknownExportError");
        assert.equal((err as UnknownExportError).code, "R402_AUTH_UNKNOWN_EXPORT");
        assert.equal((err as UnknownExportError).attemptedName, "getUser");
        assert.match((err as UnknownExportError).canonicalName, /auth\.user\(\)/);
        return true;
      },
    );
  });

  it("getUserId throws UnknownExportError with .id fix-it", () => {
    assert.throws(
      () => getUserId(),
      (err: unknown) => {
        assert.ok(err instanceof UnknownExportError);
        assert.match((err as UnknownExportError).canonicalName, /auth\.user\(\).*\?\.id/);
        return true;
      },
    );
  });

  it("getRole throws UnknownExportError pointing at auth.requireRole(role)", () => {
    assert.throws(
      () => getRole(),
      (err: unknown) => {
        assert.ok(err instanceof UnknownExportError);
        assert.match((err as UnknownExportError).canonicalName, /auth\.requireRole/);
        return true;
      },
    );
  });
});
