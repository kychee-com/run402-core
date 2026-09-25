/**
 * The `tool` export that makes a routed function an MCP tool of its app.
 *
 * Declare it next to the handler of a function that has exactly one exact
 * `POST` route; the app's MCP endpoint (`https://<host>/_run402/mcp`) then
 * lists it and dispatches `tools/call` to that route as the signed-in user:
 *
 * ```ts
 * import type { ToolDeclaration } from "@run402/functions";
 *
 * export const tool = {
 *   description: "Book a table for a party at a given time.",
 *   input: {
 *     type: "object",
 *     properties: { party: { type: "integer", minimum: 1 }, at: { type: "string", format: "date-time" } },
 *     required: ["party", "at"],
 *   },
 *   annotations: { destructiveHint: false },
 * } satisfies ToolDeclaration;
 * ```
 *
 * The platform reads the declaration from the source at deploy time and never
 * executes it, so it must be a static literal: `export const tool = { … }`
 * (with `satisfies` or a type annotation) holding only strings, numbers,
 * booleans, `null`, arrays, and objects. Computed values, spreads, function
 * calls, and references to other bindings are refused at deploy.
 *
 * Type-only: nothing is emitted at runtime.
 */
export interface ToolDeclaration {
  /** What the tool does, for the model choosing it. 1-1024 characters. */
  description: string;
  /** Optional display name for people. At most 128 characters. */
  title?: string;
  /** JSON Schema (draft 2020-12) of the arguments object; `type` must be `"object"`. */
  input: ToolInputSchema;
  /** MCP tool annotations. Hints only; they grant nothing. */
  annotations?: ToolAnnotations;
}

/** The JSON Schema of a tool's arguments. */
export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  [keyword: string]: unknown;
}

/** The MCP tool annotation hints the platform passes through to `tools/list`. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
