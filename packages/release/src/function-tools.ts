/**
 * A function's MCP tools, as a release carries them.
 *
 * A tool names a request its function already answers: a method and a path.
 * Deploy tooling reads the declaration from an export beside the handler and
 * puts it on the function's release entry; nothing here reads source. This
 * module checks what can be checked from the spec alone (shape, names, the
 * path template against the input schema), normalizes, and diffs. Whether the
 * named request really reaches the function depends on the routes and static
 * files of the release that would become live, which the runtime resolves.
 */

import { canonicalizeJson } from "./canonical-json.js";
import { ReleaseSpecValidationError } from "./errors.js";
import {
  SUPPORTED_TOOL_METHODS,
  type FunctionToolSpec,
  type PortableFunctionEntry,
  type PortableFunctionTool,
  type PortableReleaseState,
  type ToolAnnotations,
  type ToolHttpMethod,
} from "./types.js";

/** The codes a tool refusal carries in `details.code`. */
export type ToolSpecErrorCode =
  | "MCP_TOOL_SCHEMA_INVALID"
  | "MCP_TOOL_NAME_INVALID"
  | "MCP_TOOL_NAME_DUPLICATE"
  | "MCP_TOOL_PATH_UNSUPPORTED";

export const MAX_TOOLS_PER_FUNCTION = 100;
export const TOOL_DESCRIPTION_MAX = 1024;
export const TOOL_TITLE_MAX = 128;
/** Serialized size ceiling for one tool (its description and schema). */
export const TOOL_DECLARATION_MAX_BYTES = 64 * 1024;

/** MCP tool names: 1 to 128 of A-Z, a-z, 0-9, `_`, `-`, `.`. */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const TOOL_KEYS = ["name", "title", "description", "input", "annotations", "method", "path"] as const;
const ANNOTATION_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const PATH_PARAM = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const QUERY_METHODS = new Set<ToolHttpMethod>(["GET", "DELETE"]);
const QUERY_SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);
const PATH_PARAM_TYPES = new Set(["string", "integer"]);

/** MCP tools added, removed, or changed between two releases, by name. */
export interface ToolsDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function isValidToolName(name: unknown): name is string {
  return typeof name === "string" && TOOL_NAME.test(name);
}

/** Does this method send its arguments as a query string (no body)? */
export function toolMethodUsesQuery(method: ToolHttpMethod): boolean {
  return QUERY_METHODS.has(method);
}

/** The `{param}` names of a tool path, in order. The path must already be valid. */
export function toolPathParams(path: string): string[] {
  return path
    .split("/")
    .map((segment) => PATH_PARAM.exec(segment)?.[1])
    .filter((name): name is string => name !== undefined);
}

function refuse(
  code: ToolSpecErrorCode,
  resource: string,
  message: string,
  details: Record<string, unknown> = {},
): ReleaseSpecValidationError {
  return new ReleaseSpecValidationError(resource, message, { code, ...details });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check one function entry's `tools`. `resource` is the entry's `tools` path
 * (`functions.replace.<name>.tools`).
 */
export function validateFunctionTools(value: unknown, resource: string, functionName: string): void {
  const about = { function: functionName };
  if (!Array.isArray(value)) {
    throw refuse("MCP_TOOL_SCHEMA_INVALID", resource, "A function's tools must be an array.", about);
  }
  if (value.length > MAX_TOOLS_PER_FUNCTION) {
    throw refuse(
      "MCP_TOOL_SCHEMA_INVALID",
      resource,
      `A function carries at most ${MAX_TOOLS_PER_FUNCTION} tools; this one has ${value.length}.`,
      about,
    );
  }
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const at = `${resource}[${i}]`;
    const tool = value[i] as unknown;
    if (!isRecord(tool)) {
      throw refuse("MCP_TOOL_SCHEMA_INVALID", at, "A tool must be an object.", about);
    }
    const name = validateToolName(tool, at, functionName, value.length);
    const on = { function: functionName, tool: name };
    for (const key of Object.keys(tool)) {
      if (!(TOOL_KEYS as readonly string[]).includes(key)) {
        throw refuse(
          "MCP_TOOL_SCHEMA_INVALID",
          `${at}.${key}`,
          `Unknown field \`${key}\`; a tool carries ${TOOL_KEYS.join(", ")}.`,
          on,
        );
      }
    }
    if (seen.has(name)) {
      throw refuse(
        "MCP_TOOL_NAME_DUPLICATE",
        `${at}.name`,
        `Function \`${functionName}\` has two tools named \`${name}\`; a tool's name is unique in the release.`,
        { functions: [functionName], tool: name },
      );
    }
    seen.add(name);
    validateToolText(tool, at, on);
    const input = validateToolInput(tool, at, on);
    validateToolAnnotations(tool, at, on);
    const method = validateToolMethod(tool, at, on);
    const params = validateToolPath(tool, at, on);
    validateToolArgumentsAgainstRequest(input, method, params, at, on);
    if (new TextEncoder().encode(JSON.stringify(tool)).length > TOOL_DECLARATION_MAX_BYTES) {
      throw refuse(
        "MCP_TOOL_SCHEMA_INVALID",
        at,
        `A tool must serialize to at most ${TOOL_DECLARATION_MAX_BYTES} bytes.`,
        on,
      );
    }
  }
}

function validateToolName(tool: Record<string, unknown>, at: string, functionName: string, count: number): string {
  if (tool.name === undefined) {
    if (count > 1) {
      throw refuse(
        "MCP_TOOL_NAME_INVALID",
        `${at}.name`,
        `Function \`${functionName}\` has several tools, so each needs a name; only a function's single tool may take the function's name.`,
        { function: functionName },
      );
    }
    return functionName;
  }
  if (!isValidToolName(tool.name)) {
    throw refuse(
      "MCP_TOOL_NAME_INVALID",
      `${at}.name`,
      "A tool's name must be 1 to 128 of A-Z, a-z, 0-9, `_`, `-` and `.`.",
      { function: functionName },
    );
  }
  return tool.name;
}

function validateToolText(tool: Record<string, unknown>, at: string, on: Record<string, unknown>): void {
  const description = tool.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    throw refuse("MCP_TOOL_SCHEMA_INVALID", `${at}.description`, "`description` must be a non-empty string.", on);
  }
  if (description.length > TOOL_DESCRIPTION_MAX) {
    throw refuse(
      "MCP_TOOL_SCHEMA_INVALID",
      `${at}.description`,
      `\`description\` must be at most ${TOOL_DESCRIPTION_MAX} characters.`,
      on,
    );
  }
  const title = tool.title;
  if (title !== undefined && (typeof title !== "string" || title.length === 0 || title.length > TOOL_TITLE_MAX)) {
    throw refuse(
      "MCP_TOOL_SCHEMA_INVALID",
      `${at}.title`,
      `\`title\` must be a string of 1 to ${TOOL_TITLE_MAX} characters.`,
      on,
    );
  }
}

function validateToolInput(
  tool: Record<string, unknown>,
  at: string,
  on: Record<string, unknown>,
): Record<string, unknown> {
  const input = tool.input;
  if (!isRecord(input)) {
    throw refuse("MCP_TOOL_SCHEMA_INVALID", `${at}.input`, "`input` must be a JSON Schema object.", on);
  }
  if (input.type !== "object") {
    throw refuse(
      "MCP_TOOL_SCHEMA_INVALID",
      `${at}.input.type`,
      "`input.type` must be \"object\": a tool's arguments are a JSON object.",
      on,
    );
  }
  if (input.properties !== undefined && !isRecord(input.properties)) {
    throw refuse("MCP_TOOL_SCHEMA_INVALID", `${at}.input.properties`, "`input.properties` must be an object.", on);
  }
  if (
    input.required !== undefined &&
    (!Array.isArray(input.required) || input.required.some((name) => typeof name !== "string"))
  ) {
    throw refuse("MCP_TOOL_SCHEMA_INVALID", `${at}.input.required`, "`input.required` must be an array of names.", on);
  }
  return input;
}

function validateToolAnnotations(tool: Record<string, unknown>, at: string, on: Record<string, unknown>): void {
  const annotations = tool.annotations;
  if (annotations === undefined) return;
  if (!isRecord(annotations)) {
    throw refuse("MCP_TOOL_SCHEMA_INVALID", `${at}.annotations`, "`annotations` must be an object.", on);
  }
  for (const [key, value] of Object.entries(annotations)) {
    if (!(ANNOTATION_KEYS as readonly string[]).includes(key)) {
      throw refuse(
        "MCP_TOOL_SCHEMA_INVALID",
        `${at}.annotations.${key}`,
        `Unknown annotation \`${key}\`; allowed: ${ANNOTATION_KEYS.join(", ")}.`,
        on,
      );
    }
    if (typeof value !== "boolean") {
      throw refuse("MCP_TOOL_SCHEMA_INVALID", `${at}.annotations.${key}`, `\`annotations.${key}\` must be a boolean.`, on);
    }
  }
}

function validateToolMethod(tool: Record<string, unknown>, at: string, on: Record<string, unknown>): ToolHttpMethod {
  if (tool.method === undefined) return "POST";
  if (!(SUPPORTED_TOOL_METHODS as readonly unknown[]).includes(tool.method)) {
    throw refuse(
      "MCP_TOOL_SCHEMA_INVALID",
      `${at}.method`,
      `\`method\` must be one of ${SUPPORTED_TOOL_METHODS.join(", ")}.`,
      on,
    );
  }
  return tool.method as ToolHttpMethod;
}

/** Returns the path's parameter names (none when the tool names no path). */
function validateToolPath(tool: Record<string, unknown>, at: string, on: Record<string, unknown>): string[] {
  const path = tool.path;
  if (path === undefined) return [];
  const where = `${at}.path`;
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw refuse("MCP_TOOL_SCHEMA_INVALID", where, "`path` must be a path that starts with `/`.", on);
  }
  if (path.includes("*") || path.includes("...")) {
    throw refuse(
      "MCP_TOOL_PATH_UNSUPPORTED",
      where,
      "A tool's path cannot hold a wildcard or a rest segment: each `{param}` stands for exactly one path segment.",
      on,
    );
  }
  if (path === "/") return [];
  const params: string[] = [];
  for (const segment of path.slice(1).split("/")) {
    const param = PATH_PARAM.exec(segment)?.[1];
    if (param !== undefined) {
      if (params.includes(param)) {
        throw refuse("MCP_TOOL_SCHEMA_INVALID", where, `\`path\` names the parameter \`${param}\` twice.`, on);
      }
      params.push(param);
      continue;
    }
    if (!PATH_SEGMENT.test(segment)) {
      throw refuse(
        "MCP_TOOL_SCHEMA_INVALID",
        where,
        "`path` segments are literal text (A-Z, a-z, 0-9, `.`, `_`, `~`, `-`) or one `{param}` each, with no empty segment, query or fragment.",
        on,
      );
    }
  }
  return params;
}

function validateToolArgumentsAgainstRequest(
  input: Record<string, unknown>,
  method: ToolHttpMethod,
  params: readonly string[],
  at: string,
  on: Record<string, unknown>,
): void {
  const properties = (input.properties ?? {}) as Record<string, unknown>;
  const required = new Set((input.required ?? []) as string[]);
  for (const param of params) {
    const property = properties[param];
    if (!isRecord(property) || typeof property.type !== "string" || !PATH_PARAM_TYPES.has(property.type)) {
      throw refuse(
        "MCP_TOOL_SCHEMA_INVALID",
        `${at}.input.properties.${param}`,
        `The path parameter \`${param}\` must be a property of \`input\` whose type is "string" or "integer".`,
        on,
      );
    }
    if (!required.has(param)) {
      throw refuse(
        "MCP_TOOL_SCHEMA_INVALID",
        `${at}.input.required`,
        `The path parameter \`${param}\` must be listed in \`input.required\`.`,
        on,
      );
    }
  }
  if (!toolMethodUsesQuery(method)) return;
  for (const [name, property] of Object.entries(properties)) {
    if (params.includes(name)) continue;
    if (!isRecord(property) || typeof property.type !== "string" || !QUERY_SCALAR_TYPES.has(property.type)) {
      throw refuse(
        "MCP_TOOL_SCHEMA_INVALID",
        `${at}.input.properties.${name}`,
        `A ${method} tool sends its arguments as a query string, so \`${name}\` must have the type "string", "number", "integer" or "boolean".`,
        on,
      );
    }
  }
}

/**
 * A function's tools as a release holds them: each named (a single unnamed
 * tool takes the function's name), with its method, sorted by name. Empty when
 * the function has none.
 */
export function normalizeFunctionTools(
  tools: readonly FunctionToolSpec[] | readonly PortableFunctionTool[] = [],
  functionName: string,
): PortableFunctionTool[] {
  return tools
    .map((tool) => {
      const annotations = normalizeAnnotations(tool.annotations);
      const normalized: PortableFunctionTool = {
        name: tool.name ?? functionName,
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        description: tool.description,
        input: JSON.parse(JSON.stringify(tool.input)) as Record<string, unknown>,
        ...(annotations ? { annotations } : {}),
        method: tool.method ?? "POST",
        ...(tool.path !== undefined ? { path: tool.path } : {}),
      };
      return normalized;
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function normalizeAnnotations(annotations: ToolAnnotations | undefined): ToolAnnotations | undefined {
  if (!annotations) return undefined;
  const out: ToolAnnotations = {};
  for (const key of ANNOTATION_KEYS) {
    if (annotations[key] !== undefined) out[key] = annotations[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Tool names are unique across the functions of one release. `entries` is the
 * function list of the spec, or of the release that would become live.
 */
export function assertUniqueToolNames(
  entries: ReadonlyArray<{ name: string; tools?: readonly FunctionToolSpec[] | readonly PortableFunctionTool[] }>,
): void {
  const owner = new Map<string, string>();
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const tools = entry.tools ?? [];
    for (const tool of tools) {
      const name = tool.name ?? entry.name;
      const first = owner.get(name);
      if (first !== undefined && first !== entry.name) {
        throw refuse(
          "MCP_TOOL_NAME_DUPLICATE",
          "functions",
          `Functions \`${first}\` and \`${entry.name}\` both declare a tool named \`${name}\`; a tool's name is unique in the release.`,
          { functions: [first, entry.name], tool: name },
        );
      }
      owner.set(name, entry.name);
    }
  }
}

/** One function's tools in a form two releases can be compared by. */
export function functionToolsIdentity(entry: Pick<PortableFunctionEntry, "name" | "tools">): string {
  return canonicalizeJson(normalizeFunctionTools(entry.tools ?? [], entry.name));
}

/** Tools added, removed or changed between two releases, by name. A tool that moved to another function changed. */
export function computeToolsDiff(from: PortableReleaseState, to: PortableReleaseState): ToolsDiff {
  const index = (state: PortableReleaseState): Map<string, string> => {
    const byName = new Map<string, string>();
    for (const fn of state.functions) {
      for (const tool of normalizeFunctionTools(fn.tools ?? [], fn.name)) {
        byName.set(tool.name, canonicalizeJson({ function: fn.name, tool }));
      }
    }
    return byName;
  };
  const before = index(from);
  const after = index(to);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [name, identity] of after) {
    const previous = before.get(name);
    if (previous === undefined) added.push(name);
    else if (previous !== identity) changed.push(name);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) removed.push(name);
  }
  const ascii = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return { added: added.sort(ascii), removed: removed.sort(ascii), changed: changed.sort(ascii) };
}
