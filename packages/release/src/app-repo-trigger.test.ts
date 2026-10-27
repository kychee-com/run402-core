import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ReleaseSpecValidationError,
  computeApplyRequestDigestHex,
  computeReleaseDiff,
  materializeRelease,
  validateReleaseSpec,
  type ReleaseSpec,
} from "./index.js";

const SOURCE = { sha256: "a".repeat(64), size: 10 };

function specWith(trigger: Record<string, unknown>, patch = false): ReleaseSpec {
  const fn = { runtime: "node22", source: SOURCE, triggers: [trigger] };
  return {
    project: "p0001",
    functions: patch ? { patch: { set: { bundle: fn } } } : { replace: { bundle: fn } },
  } as unknown as ReleaseSpec;
}

function isInvalidAt(resource: string, message?: RegExp) {
  return (error: unknown) =>
    error instanceof ReleaseSpecValidationError &&
    error.resource === resource &&
    (message === undefined || message.test(error.message));
}

const AT = "functions.replace.bundle.triggers[0]";
const base = { id: "bundle", type: "app_repo", repo: "default", run: { event_type: "content.changed" } };

describe("app_repo function triggers", () => {
  it("accepts an app_repo trigger with and without paths, under replace and patch.set", () => {
    validateReleaseSpec(specWith(base));
    validateReleaseSpec(specWith({ ...base, paths: ["people/", "stories"] }));
    validateReleaseSpec(specWith({ ...base, paths: ["people/"] }, true));
    assert.match(computeApplyRequestDigestHex(specWith(base)), /^[0-9a-f]{64}$/);
  });

  it("materializes canonically: paths sorted, spelling kept, payload defaulted", () => {
    const state = materializeRelease({ spec: specWith({ ...base, paths: ["stories", "people/"] }) });
    assert.deepEqual(state.functions[0]?.triggers, [{
      id: "bundle",
      type: "app_repo",
      repo: "default",
      paths: ["people/", "stories"],
      run: { event_type: "content.changed", payload: {} },
    }]);
    const without = materializeRelease({ spec: specWith(base) });
    assert.deepEqual(without.functions[0]?.triggers?.[0], {
      id: "bundle", type: "app_repo", repo: "default", run: { event_type: "content.changed", payload: {} },
    });
    assert.deepEqual(computeReleaseDiff(without, state).functions.changed, [
      { name: "bundle", fields_changed: ["triggers"] },
    ]);
  });

  it("refuses schedule and email fields on an app_repo trigger", () => {
    for (const [key, value, message] of [
      ["cron", "* * * * *", /schedule fields/],
      ["timezone", "UTC", /schedule fields/],
      ["misfire_policy", "skip", /schedule fields/],
      ["overlap_policy", "allow", /schedule fields/],
      ["mailbox", "inbox", /mailbox or events/],
      ["events", ["bounced"], /mailbox or events/],
    ] as const) {
      assert.throws(() => validateReleaseSpec(specWith({ ...base, [key]: value })), isInvalidAt(AT, message), key);
    }
  });

  it("refuses repo and paths on schedule and email triggers", () => {
    const schedule = { id: "s", type: "schedule", cron: "* * * * *", run: { event_type: "tick" } };
    const email = { id: "e", type: "email", mailbox: "inbox", events: ["bounced"], run: { event_type: "mail" } };
    for (const trigger of [schedule, email]) {
      for (const extra of [{ repo: "default" }, { paths: ["a/"] }]) {
        assert.throws(
          () => validateReleaseSpec(specWith({ ...trigger, ...extra })),
          isInvalidAt(AT, /cannot include repo or paths/),
        );
      }
    }
  });

  it("refuses a bad repo name", () => {
    for (const repo of [undefined, "", "Default", "a/b", "x.git", "-a", "a".repeat(65)]) {
      assert.throws(
        () => validateReleaseSpec(specWith({ ...base, repo })),
        isInvalidAt(`${AT}.repo`),
        String(repo),
      );
    }
  });

  it("refuses bad paths", () => {
    assert.throws(() => validateReleaseSpec(specWith({ ...base, paths: "people/" })), isInvalidAt(`${AT}.paths`));
    assert.throws(() => validateReleaseSpec(specWith({ ...base, paths: [] })), isInvalidAt(`${AT}.paths`, /1-50/));
    assert.throws(
      () => validateReleaseSpec(specWith({ ...base, paths: Array.from({ length: 51 }, (_, i) => `p${i}/`) })),
      isInvalidAt(`${AT}.paths`, /1-50/),
    );
    for (const path of ["", "/people", "a//b", "./a", "a/../b", ".git/", "a/.GIT", "x".repeat(1025), 3]) {
      assert.throws(
        () => validateReleaseSpec(specWith({ ...base, paths: ["ok/", path] })),
        isInvalidAt(`${AT}.paths[1]`),
        String(path).slice(0, 20),
      );
    }
    validateReleaseSpec(specWith({ ...base, paths: ["x".repeat(1024)] }));
  });

  it("names all three trigger types for an unknown type", () => {
    assert.throws(
      () => validateReleaseSpec(specWith({ ...base, type: "webhook" })),
      isInvalidAt(`${AT}.type`, /schedule, email or app_repo/),
    );
  });
});
