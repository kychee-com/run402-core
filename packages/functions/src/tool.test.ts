import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as functions from "./index.js";
import type { ToolDeclaration } from "./index.js";

describe("ToolDeclaration", () => {
  it("is type-only: the package gains no runtime export", () => {
    assert.equal("ToolDeclaration" in functions, false);
    assert.equal("tool" in functions, false);
  });

  it("types the static literal the platform reads at deploy", () => {
    const tool = {
      description: "Cancel one of the signed-in user's bookings.",
      input: { type: "object", properties: { booking_id: { type: "string" } }, required: ["booking_id"] },
      annotations: { destructiveHint: true, idempotentHint: true },
    } satisfies ToolDeclaration;
    // A declaration survives a JSON round trip unchanged: it holds only literals.
    assert.deepEqual(JSON.parse(JSON.stringify(tool)), tool);
  });
});
