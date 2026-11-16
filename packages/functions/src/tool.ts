/**
 * The `tool` and `tools` exports that make a request your app already answers
 * an MCP tool of the app.
 *
 * Declare a tool beside the handler it calls. The app's MCP endpoint
 * (`https://<host>/_run402/mcp`) then lists it, and a `tools/call` is that
 * request, sent as the signed-in user through the app's own gate:
 *
 * ```ts
 * // a function with one exact POST route: the tool takes the function's name
 * import type { ToolDeclaration } from "@run402/functions";
 *
 * export const tool = {
 *   description: "Book a table for a party at a given time.",
 *   input: {
 *     type: "object",
 *     properties: { party: { type: "integer", minimum: 1 }, at: { type: "string", format: "date-time" } },
 *     required: ["party", "at"],
 *   },
 * } satisfies ToolDeclaration;
 * ```
 *
 * ```ts
 * // several tools in one file: the key is the tool's name
 * import type { ToolDeclarations } from "@run402/functions";
 *
 * export const tools = {
 *   list_notes: { method: "GET", description: "List notes.", input: { type: "object", properties: { tag: { type: "string" } } } },
 *   add_note: { method: "POST", description: "Add a note.", input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
 * } satisfies ToolDeclarations;
 * ```
 *
 * Your deploy tooling (`run402 deploy`, `run402 up`, `@run402/sdk/node`,
 * `@run402/astro`) reads the export by parsing the file, never by running it,
 * and carries it in the release as the function's `tools`. So it must be a
 * static literal: an object holding only strings, numbers, booleans, `null`,
 * arrays, and objects (`satisfies` and type annotations are fine). Computed
 * values, spreads, function calls, and references to other bindings are
 * refused before anything is deployed. The platform itself never reads your
 * source for tools: over raw HTTP you send `functions.<name>.tools` yourself.
 *
 * Type-only: nothing is emitted at runtime.
 */
export interface ToolDeclaration {
  /**
   * The tool's name, unique in the app. 1-128 of A-Z, a-z, 0-9, `_`, `-`, `.`.
   * Under `tools` the key is the name and this field is not written. A
   * function file's single `tool` may omit it: it is then the function's
   * name. An Astro endpoint file's single `tool` must state it.
   */
  name?: string;
  /** What the tool does, for the model choosing it. 1-1024 characters. */
  description: string;
  /** Optional display name for people. At most 128 characters. */
  title?: string;
  /** JSON Schema (draft 2020-12) of the arguments object; `type` must be `"object"`. */
  input: ToolInputSchema;
  /** MCP tool annotations. Hints only; they grant nothing. */
  annotations?: ToolAnnotations;
  /**
   * The method of the request the tool sends. A function file defaults to
   * `POST`. An Astro endpoint file defaults to the one handler it exports and
   * must state it when it exports several. `GET` and `DELETE` send the
   * arguments as a query string, so every argument that is not a path
   * parameter must be a string, number, integer or boolean; the other methods
   * send them as a JSON body.
   */
  method?: ToolMethod;
  /**
   * The path of the request, in a function file only: it may hold `{param}`
   * segments, each filled from the required string or integer argument of
   * that name. Omitted, the tool is sent to the function's one exact `POST`
   * route. Never written in an Astro endpoint file, whose own route is the
   * path.
   */
  path?: string;
}

/** Several tools declared in one file, keyed by tool name. */
export type ToolDeclarations = Record<string, Omit<ToolDeclaration, "name">>;

/** The methods a tool call can send. */
export type ToolMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

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
  /**
   * A `GET` tool is listed read-only without this. Set it to `false` on a
   * `GET` whose handler leaves a mark (it records a read, for example), so a
   * host does not treat the call as free of effect.
   */
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
