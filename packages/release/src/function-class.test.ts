import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ReleaseSpecValidationError,
  computeApplyRequestDigestHex,
  materializeRelease,
  validateReleaseSpec,
  type ReleaseSpec,
} from "./index.js";

const SOURCE = { sha256: "a".repeat(64), size: 10 };

function specWithClass(cls: unknown): ReleaseSpec {
  return {
    project: "p0001",
    functions: {
      replace: {
        worker: { runtime: "node22", source: SOURCE, class: cls, config: { timeoutSeconds: 300 } },
      },
    },
  } as unknown as ReleaseSpec;
}

describe("function class", () => {
  it("accepts standard, ssr and run", () => {
    for (const cls of ["standard", "ssr", "run"]) validateReleaseSpec(specWithClass(cls));
    assert.match(computeApplyRequestDigestHex(specWithClass("run")), /^[0-9a-f]{64}$/);
  });

  it("refuses any other class", () => {
    assert.throws(
      () => validateReleaseSpec(specWithClass("background")),
      (error: unknown) =>
        error instanceof ReleaseSpecValidationError &&
        error.resource === "functions.replace.worker.class" &&
        /standard, ssr or run/.test(error.message),
    );
  });

  it("carries a run class into the materialized function", () => {
    const release = materializeRelease({ spec: specWithClass("run") });
    const fn = release.functions.find((entry) => entry.name === "worker");
    assert.equal(fn?.class, "run");
  });
});
