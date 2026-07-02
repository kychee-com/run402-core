import { ReleaseSpecValidationError } from "./errors.js";
import { validateReleaseSpec } from "./validate.js";
import type { ReleaseSpec } from "./types.js";

export const RUN402_APP_MANIFEST_FILENAME = "run402.json" as const;
export const RUN402_RELEASE_MANIFEST_FILENAME = "run402.release.json" as const;
export const RUN402_APP_SPEC_VERSION = 1 as const;
export const RUN402_APP_SCHEMA_VERSION = "run402.app_spec.v1" as const;
export const RUN402_APP_SCHEMA_ID = "https://run402.com/schemas/run402-app.v1.schema.json" as const;

export const RUN402_BINDING_CLASSES = [
  "generated_config_binding",
  "generated_secret_binding",
  "user_secret",
] as const;

export const RUN402_BINDING_SCOPES = [
  "build",
  "runtime",
  "client",
  "verify",
  "template",
] as const;

export type Run402BindingClass = (typeof RUN402_BINDING_CLASSES)[number];
export type Run402BindingScope = (typeof RUN402_BINDING_SCOPES)[number];

export interface Run402AppMetadata {
  id: string;
  display_name?: string;
  description?: string;
}

export interface Run402AppProjectOriginSpec {
  subdomain?: string;
}

export interface Run402AppProjectSpec {
  name?: string;
  id?: string;
  origin?: Run402AppProjectOriginSpec;
}

export type Run402MailboxRole = "default_outbound" | "auth_sender";

export interface Run402AppMailboxSpec {
  slug?: string;
  roles?: Run402MailboxRole[];
  description?: string;
}

export interface Run402AppWebhookSigningSpec {
  required?: boolean;
}

export interface Run402AppWebhookSpec {
  mailbox: string;
  url: string;
  events: string[];
  enabled?: boolean;
  signing?: Run402AppWebhookSigningSpec;
}

export interface Run402AppResourcesSpec {
  mailboxes?: Record<string, Run402AppMailboxSpec>;
  webhooks?: Record<string, Run402AppWebhookSpec>;
}

export interface Run402AppSecretSpec {
  required?: boolean;
  source_env?: string;
  description?: string;
}

export interface Run402AppBuildCommand {
  id: string;
  argv?: string[];
  shell?: string;
  cwd?: string;
}

export interface Run402AppBuildSpec {
  mode?: "local" | "remote" | "sandbox";
  commands?: Run402AppBuildCommand[];
}

export type Run402AppReleaseSpec = Omit<Partial<ReleaseSpec>, "project" | "idempotency_key"> & {
  project?: never;
  idempotency_key?: never;
};

export interface Run402AppLifecycleSpec {
  project?: "per_app" | "shared";
  prune?: "approval_required" | "disabled";
}

export interface Run402AppHttpVerifyExpect {
  status: number;
}

export interface Run402AppHttpVerifySpec {
  id: string;
  path?: string;
  url?: string;
  expect: Run402AppHttpVerifyExpect;
  retries?: number;
}

export interface Run402AppVerifySpec {
  http?: Run402AppHttpVerifySpec[];
}

export interface Run402AppSpec {
  $schema: typeof RUN402_APP_SCHEMA_ID;
  spec_version: typeof RUN402_APP_SPEC_VERSION;
  app: Run402AppMetadata;
  project: Run402AppProjectSpec;
  resources?: Run402AppResourcesSpec;
  secrets?: Record<string, Run402AppSecretSpec>;
  build?: Run402AppBuildSpec;
  release: Run402AppReleaseSpec;
  lifecycle?: Run402AppLifecycleSpec;
  verify?: Run402AppVerifySpec;
}

export interface GeneratedMailboxBindings {
  id: string;
  address: string;
}

const TOP_LEVEL_KEYS = [
  "$schema",
  "spec_version",
  "app",
  "project",
  "resources",
  "secrets",
  "build",
  "release",
  "lifecycle",
  "verify",
] as const;

const APP_KEYS = ["id", "display_name", "description"] as const;
const PROJECT_KEYS = ["name", "id", "origin"] as const;
const PROJECT_ORIGIN_KEYS = ["subdomain"] as const;
const RESOURCES_KEYS = ["mailboxes", "webhooks"] as const;
const MAILBOX_KEYS = ["slug", "roles", "description"] as const;
const WEBHOOK_KEYS = ["mailbox", "url", "events", "enabled", "signing"] as const;
const WEBHOOK_SIGNING_KEYS = ["required"] as const;
const SECRET_KEYS = ["required", "source_env", "description"] as const;
const BUILD_KEYS = ["mode", "commands"] as const;
const BUILD_COMMAND_KEYS = ["id", "argv", "shell", "cwd"] as const;
const LIFECYCLE_KEYS = ["project", "prune"] as const;
const VERIFY_KEYS = ["http"] as const;
const HTTP_VERIFY_KEYS = ["id", "path", "url", "expect", "retries"] as const;
const HTTP_VERIFY_EXPECT_KEYS = ["status"] as const;

const LOGICAL_RESOURCE_NAME = /^[a-z][a-z0-9_]*$/;
const APP_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const BUILD_STEP_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const TEMPLATE_REF = /\$\{([^}]+)\}/g;
const RELEASE_NODE_PROJECT_SENTINEL = "__run402_app_release_node__";

const STATIC_TEMPLATE_BINDINGS = new Set<string>([
  "input.name",
  "RUN402_PROJECT_ID",
  "RUN402_API_BASE_URL",
  "RUN402_RELEASE_ID",
  "RUN402_DEPLOYMENT_ID",
  "RUN402_PUBLIC_ORIGIN",
]);

export function parseRun402AppSpec(input: unknown): Run402AppSpec {
  if (!isRecord(input)) {
    throw invalid("app", "Run402AppSpec must be an object");
  }
  const spec = input as unknown as Run402AppSpec;
  validateRun402AppSpec(spec);
  return spec;
}

export function validateRun402AppSpec(spec: Run402AppSpec): void {
  if (!isRecord(spec)) throw invalid("app", "Run402AppSpec must be an object");
  rejectUnknownKeys(spec, "", TOP_LEVEL_KEYS);

  if (spec.$schema !== RUN402_APP_SCHEMA_ID) {
    throw invalid("$schema", `$schema must be ${RUN402_APP_SCHEMA_ID}`);
  }
  if (spec.spec_version !== RUN402_APP_SPEC_VERSION) {
    throw invalid("spec_version", `spec_version must be ${RUN402_APP_SPEC_VERSION}`);
  }

  validateAppMetadata(spec.app);
  validateProject(spec.project);
  validateResources(spec.resources);
  validateAppSecrets(spec.secrets);
  validateBuild(spec.build);
  validateReleaseNode(spec.release);
  validateLifecycle(spec.lifecycle);
  validateVerify(spec.verify);
  validateTemplateReferences(spec);
}

export function isRun402LogicalResourceName(value: string): boolean {
  return LOGICAL_RESOURCE_NAME.test(value);
}

export function generatedMailboxBindings(logicalName: string): GeneratedMailboxBindings {
  assertLogicalResourceName(logicalName, `resources.mailboxes.${logicalName}`);
  const suffix = logicalName.toUpperCase();
  return {
    id: `RUN402_MAILBOX_${suffix}_ID`,
    address: `RUN402_MAILBOX_${suffix}_ADDRESS`,
  };
}

function validateAppMetadata(app: Run402AppMetadata): void {
  if (!isRecord(app)) throw invalid("app", "app must be an object");
  rejectUnknownKeys(app, "app", APP_KEYS);
  if (typeof app.id !== "string" || !APP_ID.test(app.id)) {
    throw invalid("app.id", "app.id must be a lowercase app identifier");
  }
  if (app.display_name !== undefined && typeof app.display_name !== "string") {
    throw invalid("app.display_name", "app.display_name must be a string");
  }
  if (app.description !== undefined && typeof app.description !== "string") {
    throw invalid("app.description", "app.description must be a string");
  }
}

function validateProject(project: Run402AppProjectSpec): void {
  if (!isRecord(project)) throw invalid("project", "project must be an object");
  rejectUnknownKeys(project, "project", PROJECT_KEYS);
  if (project.name !== undefined) validateTemplateString(project.name, "project.name");
  if (project.id !== undefined && (typeof project.id !== "string" || project.id.length === 0)) {
    throw invalid("project.id", "project.id must be a non-empty string");
  }
  if (project.origin !== undefined) {
    if (!isRecord(project.origin)) throw invalid("project.origin", "project.origin must be an object");
    rejectUnknownKeys(project.origin, "project.origin", PROJECT_ORIGIN_KEYS);
    if (project.origin.subdomain !== undefined) validateTemplateString(project.origin.subdomain, "project.origin.subdomain");
  }
}

function validateResources(resources: Run402AppResourcesSpec | undefined): void {
  if (resources === undefined) return;
  if (!isRecord(resources)) throw invalid("resources", "resources must be an object");
  rejectUnknownKeys(resources, "resources", RESOURCES_KEYS);
  const resourceSpec = resources as Run402AppResourcesSpec;
  validateMailboxes(resourceSpec.mailboxes);
  validateWebhooks(resourceSpec.webhooks, resourceSpec.mailboxes ?? {});
}

function validateMailboxes(mailboxes: Record<string, Run402AppMailboxSpec> | undefined): void {
  if (mailboxes === undefined) return;
  if (!isRecord(mailboxes)) throw invalid("resources.mailboxes", "resources.mailboxes must be an object");
  for (const [name, mailbox] of Object.entries(mailboxes)) {
    assertLogicalResourceName(name, `resources.mailboxes.${name}`);
    if (!isRecord(mailbox)) throw invalid(`resources.mailboxes.${name}`, "mailbox must be an object");
    rejectUnknownKeys(mailbox, `resources.mailboxes.${name}`, MAILBOX_KEYS);
    if (mailbox.slug !== undefined && typeof mailbox.slug !== "string") {
      throw invalid(`resources.mailboxes.${name}.slug`, "mailbox slug must be a string");
    }
    if (mailbox.description !== undefined && typeof mailbox.description !== "string") {
      throw invalid(`resources.mailboxes.${name}.description`, "mailbox description must be a string");
    }
    if (mailbox.roles !== undefined) {
      validateStringArray(mailbox.roles, `resources.mailboxes.${name}.roles`);
      for (const role of mailbox.roles) {
        if (role !== "default_outbound" && role !== "auth_sender") {
          throw invalid(`resources.mailboxes.${name}.roles`, `unsupported mailbox role '${role}'`);
        }
      }
    }
  }
}

function validateWebhooks(
  webhooks: Record<string, Run402AppWebhookSpec> | undefined,
  mailboxes: Record<string, Run402AppMailboxSpec>,
): void {
  if (webhooks === undefined) return;
  if (!isRecord(webhooks)) throw invalid("resources.webhooks", "resources.webhooks must be an object");
  for (const [name, webhook] of Object.entries(webhooks)) {
    assertLogicalResourceName(name, `resources.webhooks.${name}`);
    if (!isRecord(webhook)) throw invalid(`resources.webhooks.${name}`, "webhook must be an object");
    rejectUnknownKeys(webhook, `resources.webhooks.${name}`, WEBHOOK_KEYS);
    if (typeof webhook.mailbox !== "string" || !LOGICAL_RESOURCE_NAME.test(webhook.mailbox)) {
      throw invalid(`resources.webhooks.${name}.mailbox`, "webhook mailbox must reference a logical mailbox name");
    }
    if (mailboxes[webhook.mailbox] === undefined) {
      throw invalid(`resources.webhooks.${name}.mailbox`, `unknown mailbox '${webhook.mailbox}'`);
    }
    if (typeof webhook.url !== "string" || webhook.url.length === 0) {
      throw invalid(`resources.webhooks.${name}.url`, "webhook url must be a non-empty string");
    }
    validateTemplateString(webhook.url, `resources.webhooks.${name}.url`);
    validateStringArray(webhook.events, `resources.webhooks.${name}.events`);
    if (webhook.events.length === 0) {
      throw invalid(`resources.webhooks.${name}.events`, "webhook events must not be empty");
    }
    if (webhook.enabled !== undefined && typeof webhook.enabled !== "boolean") {
      throw invalid(`resources.webhooks.${name}.enabled`, "webhook enabled must be a boolean");
    }
    if (webhook.signing !== undefined) {
      if (!isRecord(webhook.signing)) throw invalid(`resources.webhooks.${name}.signing`, "webhook signing must be an object");
      rejectUnknownKeys(webhook.signing, `resources.webhooks.${name}.signing`, WEBHOOK_SIGNING_KEYS);
      if (webhook.signing.required !== undefined && typeof webhook.signing.required !== "boolean") {
        throw invalid(`resources.webhooks.${name}.signing.required`, "webhook signing required must be a boolean");
      }
    }
  }
}

function validateAppSecrets(secrets: Record<string, Run402AppSecretSpec> | undefined): void {
  if (secrets === undefined) return;
  if (!isRecord(secrets)) throw invalid("secrets", "secrets must be an object");
  for (const [name, secret] of Object.entries(secrets)) {
    if (name.startsWith("RUN402_")) {
      throw invalid(`secrets.${name}`, "RUN402_* is reserved for platform-generated bindings");
    }
    if (!SECRET_NAME.test(name)) {
      throw invalid(`secrets.${name}`, "secret name must be uppercase snake case");
    }
    if (!isRecord(secret)) throw invalid(`secrets.${name}`, "secret declaration must be an object");
    rejectUnknownKeys(secret, `secrets.${name}`, SECRET_KEYS);
    if (secret.required !== undefined && typeof secret.required !== "boolean") {
      throw invalid(`secrets.${name}.required`, "secret required must be a boolean");
    }
    if (secret.source_env !== undefined) {
      if (typeof secret.source_env !== "string" || !SECRET_NAME.test(secret.source_env) || secret.source_env.startsWith("RUN402_")) {
        throw invalid(`secrets.${name}.source_env`, "source_env must be a non-RUN402 uppercase environment name");
      }
    }
    if (secret.description !== undefined && typeof secret.description !== "string") {
      throw invalid(`secrets.${name}.description`, "secret description must be a string");
    }
  }
}

function validateBuild(build: Run402AppBuildSpec | undefined): void {
  if (build === undefined) return;
  if (!isRecord(build)) throw invalid("build", "build must be an object");
  rejectUnknownKeys(build, "build", BUILD_KEYS);
  if (build.mode !== undefined && build.mode !== "local" && build.mode !== "remote" && build.mode !== "sandbox") {
    throw invalid("build.mode", "build.mode must be local, remote, or sandbox");
  }
  if (build.commands !== undefined) {
    if (!Array.isArray(build.commands)) throw invalid("build.commands", "build.commands must be an array");
    for (let i = 0; i < build.commands.length; i++) validateBuildCommand(build.commands[i], `build.commands.${i}`);
  }
}

function validateBuildCommand(command: Run402AppBuildCommand, resource: string): void {
  if (!isRecord(command)) throw invalid(resource, "build command must be an object");
  rejectUnknownKeys(command, resource, BUILD_COMMAND_KEYS);
  if (typeof command.id !== "string" || !BUILD_STEP_ID.test(command.id)) {
    throw invalid(`${resource}.id`, "build command id must be lowercase kebab or snake case");
  }
  const hasArgv = command.argv !== undefined;
  const hasShell = command.shell !== undefined;
  if (hasArgv === hasShell) {
    throw invalid(resource, "build command must include exactly one of argv or shell");
  }
  if (hasArgv) {
    validateStringArray(command.argv, `${resource}.argv`);
    if (command.argv.length === 0) throw invalid(`${resource}.argv`, "argv must not be empty");
  }
  if (hasShell && (typeof command.shell !== "string" || command.shell.trim() === "")) {
    throw invalid(`${resource}.shell`, "shell command must be non-empty");
  }
  if (command.cwd !== undefined && (typeof command.cwd !== "string" || command.cwd.length === 0)) {
    throw invalid(`${resource}.cwd`, "cwd must be a non-empty string");
  }
}

function validateReleaseNode(release: Run402AppReleaseSpec): void {
  if (!isRecord(release)) throw invalid("release", "release must be an object");
  if ("project" in release) {
    throw invalid("release.project", "release.project belongs to the app install graph and is not valid in release node content");
  }
  if ("idempotency_key" in release) {
    throw invalid("release.idempotency_key", "release idempotency belongs to the app install graph");
  }
  validateReleaseSpec({
    project: RELEASE_NODE_PROJECT_SENTINEL,
    ...release,
  } as ReleaseSpec);
}

function validateLifecycle(lifecycle: Run402AppLifecycleSpec | undefined): void {
  if (lifecycle === undefined) return;
  if (!isRecord(lifecycle)) throw invalid("lifecycle", "lifecycle must be an object");
  rejectUnknownKeys(lifecycle, "lifecycle", LIFECYCLE_KEYS);
  if (lifecycle.project !== undefined && lifecycle.project !== "per_app" && lifecycle.project !== "shared") {
    throw invalid("lifecycle.project", "lifecycle.project must be per_app or shared");
  }
  if (lifecycle.prune !== undefined && lifecycle.prune !== "approval_required" && lifecycle.prune !== "disabled") {
    throw invalid("lifecycle.prune", "lifecycle.prune must be approval_required or disabled");
  }
}

function validateVerify(verify: Run402AppVerifySpec | undefined): void {
  if (verify === undefined) return;
  if (!isRecord(verify)) throw invalid("verify", "verify must be an object");
  rejectUnknownKeys(verify, "verify", VERIFY_KEYS);
  if (verify.http !== undefined) {
    if (!Array.isArray(verify.http)) throw invalid("verify.http", "verify.http must be an array");
    for (let i = 0; i < verify.http.length; i++) validateHttpVerify(verify.http[i], `verify.http.${i}`);
  }
}

function validateHttpVerify(check: Run402AppHttpVerifySpec, resource: string): void {
  if (!isRecord(check)) throw invalid(resource, "HTTP verification check must be an object");
  rejectUnknownKeys(check, resource, HTTP_VERIFY_KEYS);
  if (typeof check.id !== "string" || !BUILD_STEP_ID.test(check.id)) {
    throw invalid(`${resource}.id`, "verification id must be lowercase kebab or snake case");
  }
  const hasPath = check.path !== undefined;
  const hasUrl = check.url !== undefined;
  if (hasPath === hasUrl) {
    throw invalid(resource, "HTTP verification check must include exactly one of path or url");
  }
  if (hasPath && (typeof check.path !== "string" || !check.path.startsWith("/"))) {
    throw invalid(`${resource}.path`, "verification path must start with /");
  }
  if (hasUrl) validateTemplateString(check.url, `${resource}.url`);
  if (!isRecord(check.expect)) throw invalid(`${resource}.expect`, "verification expect must be an object");
  rejectUnknownKeys(check.expect, `${resource}.expect`, HTTP_VERIFY_EXPECT_KEYS);
  if (typeof check.expect.status !== "number" || !Number.isInteger(check.expect.status) || check.expect.status < 100 || check.expect.status > 599) {
    throw invalid(`${resource}.expect.status`, "verification status must be an HTTP status code");
  }
  if (check.retries !== undefined && (!Number.isInteger(check.retries) || check.retries < 0)) {
    throw invalid(`${resource}.retries`, "verification retries must be a non-negative integer");
  }
}

function validateTemplateReferences(spec: Run402AppSpec): void {
  const bindings = new Set(STATIC_TEMPLATE_BINDINGS);
  for (const name of Object.keys(spec.resources?.mailboxes ?? {})) {
    const mailbox = generatedMailboxBindings(name);
    bindings.add(mailbox.id);
    bindings.add(mailbox.address);
  }

  validateTemplateRefsInString(spec.project.name, "project.name", bindings);
  validateTemplateRefsInString(spec.project.origin?.subdomain, "project.origin.subdomain", bindings);

  for (const [name, webhook] of Object.entries(spec.resources?.webhooks ?? {})) {
    validateTemplateRefsInString(webhook.url, `resources.webhooks.${name}.url`, bindings);
  }
  validateReleaseEmailTriggerMailboxRefs(spec.release, bindings);
  for (let i = 0; i < (spec.verify?.http ?? []).length; i++) {
    validateTemplateRefsInString(spec.verify?.http?.[i]?.url, `verify.http.${i}.url`, bindings);
  }
}

function validateReleaseEmailTriggerMailboxRefs(release: Run402AppReleaseSpec, bindings: Set<string>): void {
  for (const [name, fn] of Object.entries(release.functions?.replace ?? {})) {
    validateFunctionEmailTriggerMailboxRefs(fn, `release.functions.replace.${name}`, bindings);
  }
  for (const [name, fn] of Object.entries(release.functions?.patch?.set ?? {})) {
    validateFunctionEmailTriggerMailboxRefs(fn, `release.functions.patch.set.${name}`, bindings);
  }
}

function validateFunctionEmailTriggerMailboxRefs(fn: unknown, resource: string, bindings: Set<string>): void {
  if (!isRecord(fn) || !Array.isArray(fn.triggers)) return;
  for (let i = 0; i < fn.triggers.length; i++) {
    const trigger = fn.triggers[i];
    if (!isRecord(trigger) || trigger.type !== "email") continue;
    validateTemplateRefsInString(
      typeof trigger.mailbox === "string" ? trigger.mailbox : undefined,
      `${resource}.triggers.${i}.mailbox`,
      bindings,
    );
  }
}

function validateTemplateString(value: unknown, resource: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(resource, `${resource} must be a non-empty string`);
  }
  for (const match of value.matchAll(TEMPLATE_REF)) {
    if (match[1]?.trim() !== match[1]) {
      throw invalid(resource, "template references must not include surrounding whitespace");
    }
  }
}

function validateTemplateRefsInString(value: string | undefined, resource: string, allowed: Set<string>): void {
  if (value === undefined) return;
  for (const match of value.matchAll(TEMPLATE_REF)) {
    const ref = match[1];
    if (!ref || !allowed.has(ref)) {
      throw invalid(resource, `unresolved template reference '${ref ?? ""}'`);
    }
  }
}

function assertLogicalResourceName(value: string, resource: string): void {
  if (!LOGICAL_RESOURCE_NAME.test(value)) {
    throw invalid(resource, "logical resource name must match [a-z][a-z0-9_]*");
  }
}

function validateStringArray(value: unknown, resource: string): asserts value is string[] {
  if (!Array.isArray(value)) throw invalid(resource, `${resource} must be an array`);
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string" || value[i].length === 0) {
      throw invalid(`${resource}[${i}]`, `${resource} entries must be non-empty strings`);
    }
  }
}

function rejectUnknownKeys(obj: unknown, resource: string, allowed: readonly string[]): void {
  if (!isRecord(obj)) return;
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const path = resource === "" ? key : `${resource}.${key}`;
      throw invalid(path, `unknown key '${key}' (allowed: ${allowed.join(", ")})`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(resource: string, message: string): ReleaseSpecValidationError {
  return new ReleaseSpecValidationError(resource, message);
}
