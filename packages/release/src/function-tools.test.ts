import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ReleaseSpecValidationError,
  computeApplyRequestDigestHex,
  computeReleaseDiff,
  digestMaterializedRelease,
  emptyPortableReleaseState,
  materializeRelease,
  normalizeFunctionTools,
  validateReleaseSpec,
  type FunctionToolSpec,
  type PlanDiffEnvelope,
  type PortableReleaseState,
  type ReleaseDiffEnvelope,
  type ReleaseSpec,
} from "./index.js";

const SOURCE = { sha256: "a".repeat(64), size: 10 };
const OTHER = { sha256: "b".repeat(64), size: 11 };
const INPUT = { type: "object", properties: { text: { type: "string" } } };

function fn(tools?: unknown, source = SOURCE): Record<string, unknown> {
  return { runtime: "node22", source, ...(tools === undefined ? {} : { tools }) };
}

function spec(functions: Record<string, unknown>, patch = false): ReleaseSpec {
  return {
    project: "p0001",
    functions: patch ? { patch: { set: functions } } : { replace: functions },
  } as unknown as ReleaseSpec;
}

function refusedWith(code: string, resource?: string, message?: RegExp) {
  return (error: unknown) =>
    error instanceof ReleaseSpecValidationError &&
    error.details.code === code &&
    (resource === undefined || error.resource === resource) &&
    (message === undefined || message.test(error.message));
}

function materialize(s: ReleaseSpec, base: PortableReleaseState = emptyPortableReleaseState()): PortableReleaseState {
  return materializeRelease({ spec: s, concreteBase: base });
}

const tool = (extra: Partial<FunctionToolSpec> = {}): FunctionToolSpec => ({
  description: "Add a note.",
  input: INPUT,
  ...extra,
});

describe("a function's tools: validation", () => {
  it("accepts one unnamed tool, several named tools, and an empty list, under replace and patch.set", () => {
    validateReleaseSpec(spec({ notes: fn([tool()]) }));
    validateReleaseSpec(spec({ notes: fn([tool({ name: "add_note" }), tool({ name: "list_notes", method: "GET" })]) }));
    validateReleaseSpec(spec({ notes: fn([]) }));
    validateReleaseSpec(spec({ notes: fn([tool({ name: "add_note", path: "/api/notes/{note_id}", input: { type: "object", properties: { note_id: { type: "string" }, text: { type: "string" } }, required: ["note_id"] } })]) }, true));
    validateReleaseSpec(spec({
      notes: fn([tool({ title: "Notes", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } })]),
    }));
  });

  it("refuses a tools value that is not an array, and an entry that is not an object", () => {
    assert.throws(() => validateReleaseSpec(spec({ notes: fn({}) })), refusedWith("MCP_TOOL_SCHEMA_INVALID", "functions.replace.notes.tools"));
    assert.throws(() => validateReleaseSpec(spec({ notes: fn(["x"]) })), refusedWith("MCP_TOOL_SCHEMA_INVALID", "functions.replace.notes.tools[0]"));
  });

  it("refuses an unknown key, naming it", () => {
    assert.throws(
      () => validateReleaseSpec(spec({ notes: fn([{ ...tool(), route: "/api/notes" }]) })),
      refusedWith("MCP_TOOL_SCHEMA_INVALID", "functions.replace.notes.tools[0].route"),
    );
  });

  it("refuses a missing, empty or over-long description, and an over-long title", () => {
    for (const description of [undefined, "", 7, "x".repeat(1025)]) {
      assert.throws(
        () => validateReleaseSpec(spec({ notes: fn([{ input: INPUT, description }]) })),
        refusedWith("MCP_TOOL_SCHEMA_INVALID", "functions.replace.notes.tools[0].description"),
      );
    }
    assert.throws(
      () => validateReleaseSpec(spec({ notes: fn([tool({ title: "x".repeat(129) })]) })),
      refusedWith("MCP_TOOL_SCHEMA_INVALID", "functions.replace.notes.tools[0].title"),
    );
  });

  it("refuses an input that is not a JSON Schema object whose root type is object", () => {
    for (const input of [undefined, "object", []]) {
      assert.throws(
        () => validateReleaseSpec(spec({ notes: fn([{ description: "x", input }]) })),
        refusedWith("MCP_TOOL_SCHEMA_INVALID", "functions.replace.notes.tools[0].input"),
      );
    }
    for (const input of [{ type: "string" }, { properties: {} }]) {
      assert.throws(
        () => validateReleaseSpec(spec({ notes: fn([{ description: "x", input }]) })),
        refusedWith("MCP_TOOL_SCHEMA_INVALID", "functions.replace.notes.tools[0].input.type"),
      );
    }
  });

  it("refuses an unknown annotation, a non-boolean hint and an unknown method", () => {
    assert.throws(
      () => validateReleaseSpec(spec({ notes: fn([{ ...tool(), annotations: { readonly: true } }]) })),
      refusedWith("MCP_TOOL_SCHEMA_INVALID", "functions.replace.notes.tools[0].annotations.readonly"),
    );
    assert.throws(
      () => validateReleaseSpec(spec({ notes: fn([{ ...tool(), annotations: { readOnlyHint: "yes" } }]) })),
      refusedWith("MCP_TOOL_SCHEMA_INVALID", "functions.replace.notes.tools[0].annotations.readOnlyHint"),
    );
    for (const method of ["get", "HEAD", "OPTIONS", 3]) {
      assert.throws(
        () => validateReleaseSpec(spec({ notes: fn([{ ...tool(), method }]) })),
        refusedWith("MCP_TOOL_SCHEMA_INVALID", "functions.replace.notes.tools[0].method"),
      );
    }
  });

  it("accepts readOnlyHint false on a GET tool: an author may say a read leaves a mark", () => {
    validateReleaseSpec(spec({ notes: fn([tool({ name: "read_thread", method: "GET", annotations: { readOnlyHint: false } })]) }));
  });

  it("refuses an invalid tool name, and several tools where one has no name", () => {
    for (const name of ["", "has space", "x".repeat(129), "slash/name"]) {
      assert.throws(
        () => validateReleaseSpec(spec({ notes: fn([tool({ name })]) })),
        refusedWith("MCP_TOOL_NAME_INVALID", "functions.replace.notes.tools[0].name"),
      );
    }
    assert.throws(
      () => validateReleaseSpec(spec({ notes: fn([tool({ name: "add_note" }), tool()]) })),
      refusedWith("MCP_TOOL_NAME_INVALID", "functions.replace.notes.tools[1].name", /several tools/),
    );
  });

  it("refuses two tools with one name, in one function and across the functions of a spec", () => {
    assert.throws(
      () => validateReleaseSpec(spec({ notes: fn([tool({ name: "search" }), tool({ name: "search" })]) })),
      refusedWith("MCP_TOOL_NAME_DUPLICATE"),
    );
    assert.throws(
      () => validateReleaseSpec(spec({ notes: fn([tool({ name: "search" })]), people: fn([tool({ name: "search" })]) })),
      (error: unknown) =>
        refusedWith("MCP_TOOL_NAME_DUPLICATE")(error) &&
        JSON.stringify((error as ReleaseSpecValidationError).details.functions) === JSON.stringify(["notes", "people"]) &&
        (error as ReleaseSpecValidationError).details.tool === "search",
    );
    // an unnamed single tool is named after its function
    assert.throws(
      () => validateReleaseSpec(spec({ search: fn([tool()]), people: fn([tool({ name: "search" })]) })),
      refusedWith("MCP_TOOL_NAME_DUPLICATE"),
    );
  });

  it("refuses a path that is not a rooted template, and a wildcard or rest segment", () => {
    for (const path of ["api/notes", "", "/api/notes?x=1", "/api/notes#top", "/api//notes", 4, "/api/{a}{b}", "/api/{1bad}", "/api/x{id}"]) {
      assert.throws(
        () => validateReleaseSpec(spec({ notes: fn([tool({ path: path as string })]) })),
        refusedWith("MCP_TOOL_SCHEMA_INVALID", "functions.replace.notes.tools[0].path"),
        `path ${String(path)}`,
      );
    }
    for (const path of ["/api/*", "/api/{...rest}", "/api/[...rest]", "/api/notes/*/x"]) {
      assert.throws(
        () => validateReleaseSpec(spec({ notes: fn([tool({ path })]) })),
        refusedWith("MCP_TOOL_PATH_UNSUPPORTED", "functions.replace.notes.tools[0].path"),
        `path ${path}`,
      );
    }
  });

  it("requires every path parameter to be a required string or integer property of input, once", () => {
    const at = "functions.replace.notes.tools[0]";
    const withParam = (input: Record<string, unknown>, path = "/api/notes/{note_id}") => spec({ notes: fn([tool({ path, input })]) });
    assert.throws(() => validateReleaseSpec(withParam({ type: "object", properties: {} })), refusedWith("MCP_TOOL_SCHEMA_INVALID", `${at}.input.properties.note_id`));
    assert.throws(
      () => validateReleaseSpec(withParam({ type: "object", properties: { note_id: { type: "boolean" } }, required: ["note_id"] })),
      refusedWith("MCP_TOOL_SCHEMA_INVALID", `${at}.input.properties.note_id`),
    );
    assert.throws(
      () => validateReleaseSpec(withParam({ type: "object", properties: { note_id: { type: "string" } } })),
      refusedWith("MCP_TOOL_SCHEMA_INVALID", `${at}.input.required`),
    );
    assert.throws(
      () => validateReleaseSpec(withParam({ type: "object", properties: { id: { type: "string" } }, required: ["id"] }, "/api/{id}/x/{id}")),
      refusedWith("MCP_TOOL_SCHEMA_INVALID", `${at}.path`),
    );
    validateReleaseSpec(withParam({ type: "object", properties: { note_id: { type: "integer" } }, required: ["note_id"] }));
  });

  it("requires the remaining input of a GET or DELETE tool to be scalars, since it travels as a query string", () => {
    const at = "functions.replace.notes.tools[0].input.properties.tags";
    for (const method of ["GET", "DELETE"] as const) {
      assert.throws(
        () => validateReleaseSpec(spec({ notes: fn([tool({ name: "t", method, input: { type: "object", properties: { tags: { type: "array" } } } })]) })),
        refusedWith("MCP_TOOL_SCHEMA_INVALID", at),
      );
      assert.throws(
        () => validateReleaseSpec(spec({ notes: fn([tool({ name: "t", method, input: { type: "object", properties: { tags: {} } } })]) })),
        refusedWith("MCP_TOOL_SCHEMA_INVALID", at),
      );
      validateReleaseSpec(spec({
        notes: fn([tool({ name: "t", method, input: { type: "object", properties: { tag: { type: "string" }, limit: { type: "integer" }, score: { type: "number" }, all: { type: "boolean" } } } })]),
      }));
    }
    // a body method takes any JSON
    validateReleaseSpec(spec({ notes: fn([tool({ input: { type: "object", properties: { tags: { type: "array" } } } })]) }));
  });

  it("refuses more than 100 tools on one function", () => {
    const many = Array.from({ length: 101 }, (_, i) => tool({ name: `t${i}` }));
    assert.throws(() => validateReleaseSpec(spec({ notes: fn(many) })), refusedWith("MCP_TOOL_SCHEMA_INVALID", "functions.replace.notes.tools"));
  });
});

describe("a function's tools: normalization", () => {
  it("names a single unnamed tool after its function, defaults the method to POST, and sorts by name", () => {
    assert.deepEqual(normalizeFunctionTools([tool()], "notes"), [{ name: "notes", description: "Add a note.", input: INPUT, method: "POST" }]);
    assert.deepEqual(
      normalizeFunctionTools([tool({ name: "b" }), tool({ name: "a", method: "GET", title: "A", path: "/api/a", annotations: { readOnlyHint: false } })], "notes").map((t) => t.name),
      ["a", "b"],
    );
    const [a] = normalizeFunctionTools([tool({ name: "a", method: "GET", title: "A", path: "/api/a", annotations: { readOnlyHint: false } })], "notes");
    assert.deepEqual(a, { name: "a", title: "A", description: "Add a note.", input: INPUT, annotations: { readOnlyHint: false }, method: "GET", path: "/api/a" });
  });

  it("drops an empty annotations object and does not share the caller's input", () => {
    const input = { type: "object", properties: {} };
    const [t] = normalizeFunctionTools([{ description: "x", input, annotations: {} }], "notes");
    assert.equal("annotations" in t!, false);
    assert.notEqual(t!.input, input);
  });
});

describe("a function's tools: the release carries them", () => {
  it("puts normalized tools on the function entry, and none when the list is empty or omitted", () => {
    const withTools = materialize(spec({ notes: fn([tool()]) }));
    assert.deepEqual(withTools.functions[0]!.tools, [{ name: "notes", description: "Add a note.", input: INPUT, method: "POST" }]);
    assert.equal("tools" in materialize(spec({ notes: fn([]) })).functions[0]!, false);
    assert.equal("tools" in materialize(spec({ notes: fn() })).functions[0]!, false);
  });

  it("omitted tools on a named function means none, as triggers do; an unnamed function keeps its tools", () => {
    const base = materialize(spec({ notes: fn([tool()]), people: fn([tool({ name: "find_person" })]) }));
    const next = materialize(spec({ notes: fn(undefined, OTHER) }, true), base);
    const byName = new Map(next.functions.map((f) => [f.name, f]));
    assert.equal("tools" in byName.get("notes")!, false);
    assert.deepEqual(byName.get("people")!.tools!.map((t) => t.name), ["find_person"]);
  });

  it("refuses a tool whose name a carried-forward function already uses", () => {
    const base = materialize(spec({ people: fn([tool({ name: "search" })]) }));
    assert.throws(
      () => materialize(spec({ notes: fn([tool({ name: "search" })]) }, true), base),
      (error: unknown) =>
        refusedWith("MCP_TOOL_NAME_DUPLICATE")(error) &&
        JSON.stringify((error as ReleaseSpecValidationError).details.functions) === JSON.stringify(["notes", "people"]),
    );
  });

  it("changes the request digest and the materialized release digest when only tools change", () => {
    const a = spec({ notes: fn([tool()]) });
    const b = spec({ notes: fn([tool({ description: "Add one note." })]) });
    assert.notEqual(computeApplyRequestDigestHex(a), computeApplyRequestDigestHex(b));
    assert.notEqual(digestMaterializedRelease(materialize(a)), digestMaterializedRelease(materialize(b)));
    assert.notEqual(digestMaterializedRelease(materialize(a)), digestMaterializedRelease(materialize(spec({ notes: fn() }))));
  });

  it("keeps the materialized release digest of a function with no tools what it was", () => {
    assert.equal(
      digestMaterializedRelease(materialize(spec({ notes: fn() }))),
      digestMaterializedRelease(materialize(spec({ notes: fn([]) }))),
    );
  });

  it("gives one digest whatever the key order of a tool's input", () => {
    const a = materialize(spec({ notes: fn([tool({ input: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } } })]) }));
    const b = materialize(spec({ notes: fn([tool({ input: { properties: { b: { type: "string" }, a: { type: "string" } }, type: "object" } })]) }));
    assert.equal(digestMaterializedRelease(a), digestMaterializedRelease(b));
  });
});

describe("a function's tools: diffs", () => {
  const empty = emptyPortableReleaseState();
  const one = materialize(spec({ notes: fn([tool({ name: "add_note" })]) }));

  it("reports tools added, removed and changed by name, in both envelopes", () => {
    const two = materialize(spec({ notes: fn([tool({ name: "add_note", description: "Add one note." }), tool({ name: "list_notes", method: "GET" })]) }));
    const none = materialize(spec({ notes: fn() }));
    const added = computeReleaseDiff(empty, one) as ReleaseDiffEnvelope;
    assert.deepEqual(added.tools, { added: ["add_note"], removed: [], changed: [] });
    const grew = computeReleaseDiff(one, two, { plan_migrations: { new: [], noop: [] } }) as PlanDiffEnvelope;
    assert.deepEqual(grew.tools, { added: ["list_notes"], removed: [], changed: ["add_note"] });
    const gone = computeReleaseDiff(one, none) as ReleaseDiffEnvelope;
    assert.deepEqual(gone.tools, { added: [], removed: ["add_note"], changed: [] });
  });

  it("names tools in a changed function's fields, and a tools-only change is not a noop", () => {
    const reworded = materialize(spec({ notes: fn([tool({ name: "add_note", description: "Add one note." })]) }));
    const diff = computeReleaseDiff(one, reworded, { plan_migrations: { new: [], noop: [] } }) as PlanDiffEnvelope;
    assert.equal(diff.is_noop, false);
    assert.deepEqual(diff.functions.changed, [{ name: "notes", fields_changed: ["tools"] }]);
    assert.match(diff.summary, /1 tool changed/);
  });

  it("does not report a change for a different key order in a tool's input", () => {
    const a = materialize(spec({ notes: fn([tool({ name: "t", input: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } } })]) }));
    const b = JSON.parse(JSON.stringify(a)) as PortableReleaseState;
    b.functions[0]!.tools![0]!.input = { properties: { b: { type: "string" }, a: { type: "string" } }, type: "object" };
    const diff = computeReleaseDiff(a, b) as ReleaseDiffEnvelope;
    assert.equal(diff.is_noop, true);
    assert.deepEqual(diff.tools, { added: [], removed: [], changed: [] });
  });

  it("reports a tool that moved to another function as changed", () => {
    const moved = materialize(spec({ notes: fn(), people: fn([tool({ name: "add_note" })]) }));
    const diff = computeReleaseDiff(one, moved) as ReleaseDiffEnvelope;
    assert.deepEqual(diff.tools, { added: [], removed: [], changed: ["add_note"] });
  });
});
