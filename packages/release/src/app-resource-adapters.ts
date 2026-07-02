import { computeEvaluatedPlanDigestHex } from "./digest.js";
import { ReleaseSpecValidationError } from "./errors.js";
import {
  generatedMailboxBindings,
  validateRun402AppSpec,
  type Run402AppSpec,
  type Run402BindingClass,
  type Run402BindingScope,
} from "./app-spec.js";

export const RUN402_APP_RESOURCE_ADAPTER_CONTRACT_VERSION = "run402.app_resource_adapter.v1" as const;
export const RUN402_APP_RESOURCE_PLAN_DIGEST_IDENTITY = "run402-app-resource-plan-v1" as const;
export const RUN402_APP_UNSUPPORTED_RESOURCE_KIND_CODE = "UNSUPPORTED_RESOURCE_KIND" as const;

export type Run402AppResourceKind =
  | "project"
  | "origin"
  | "mailbox"
  | "mailbox_webhook"
  | "secret"
  | "build"
  | "release"
  | "verify_http";

export type Run402AppResourceMutation = "none" | "ensure" | "apply" | "prune" | "delete";
export type Run402AppResourceDiagnosticSeverity = "info" | "warning" | "error";

export interface Run402AppResourceIntent {
  id: string;
  resource_kind: Run402AppResourceKind;
  logical_name?: string;
  field_path: string;
  desired: Readonly<Record<string, unknown>>;
  mutation: Run402AppResourceMutation;
  destructive: boolean;
  depends_on: string[];
}

export interface Run402AppResourceBinding {
  env: string;
  binding_class: Run402BindingClass;
  scopes: Run402BindingScope[];
  source: Run402AppResourceKind | "platform";
  logical_name?: string;
  resource_id?: string;
  value?: string;
  redacted?: boolean;
}

export interface Run402AppResourceNextAction {
  kind:
    | "choose_adapter"
    | "remove_resource"
    | "switch_runtime"
    | "read_docs"
    | "retry";
  label: string;
  command?: string;
  docs_url?: string;
  details?: Record<string, unknown>;
}

export interface Run402AppResourceDiagnostic {
  code: string;
  severity: Run402AppResourceDiagnosticSeverity;
  resource: string;
  message: string;
  next_actions?: Run402AppResourceNextAction[];
  details?: Record<string, unknown>;
}

export interface Run402AppResourcePlanNode {
  id: string;
  resource_kind: Run402AppResourceKind;
  logical_name?: string;
  field_path: string;
  adapter: string;
  status: "planned";
  input_digest: string;
  mutation: Run402AppResourceMutation;
  destructive: boolean;
  depends_on: string[];
  bindings: Run402AppResourceBinding[];
  diagnostics: Run402AppResourceDiagnostic[];
}

export interface Run402AppResourcePlanFailure {
  status: "blocked";
  code: string;
  resource_kind: Run402AppResourceKind;
  field_path: string;
  message: string;
  next_actions: Run402AppResourceNextAction[];
  alternatives?: string[];
  details?: Record<string, unknown>;
}

export type Run402AppResourceAdapterPlanResult =
  | Run402AppResourcePlanNode
  | Run402AppResourcePlanFailure;

export interface Run402AppResourceAdapterPlanContext {
  contract_version: typeof RUN402_APP_RESOURCE_ADAPTER_CONTRACT_VERSION;
  app: Run402AppSpec["app"];
  project: Run402AppSpec["project"];
}

export interface Run402AppResourceAdapter {
  resource_kind: Run402AppResourceKind;
  adapter_id: string;
  plan(
    intent: Run402AppResourceIntent,
    context: Run402AppResourceAdapterPlanContext,
  ): Run402AppResourceAdapterPlanResult;
  apply?: unknown;
  bindings?: unknown;
  verify?: unknown;
  prune?: unknown;
  down?: unknown;
}

export interface Run402AppResourcePlanOptions {
  unsupported_alternatives?: Partial<Record<Run402AppResourceKind, string[]>>;
}

export interface Run402AppResourcePlan {
  kind: "run402.app_resource_plan";
  contract_version: typeof RUN402_APP_RESOURCE_ADAPTER_CONTRACT_VERSION;
  status: "planned" | "blocked";
  graph_digest: string;
  intents: Run402AppResourceIntent[];
  nodes: Run402AppResourcePlanNode[];
  diagnostics: Run402AppResourceDiagnostic[];
  next_actions: Run402AppResourceNextAction[];
}

export function collectRun402AppResourceIntents(spec: Run402AppSpec): Run402AppResourceIntent[] {
  validateRun402AppSpec(spec);

  const intents: Run402AppResourceIntent[] = [
    {
      id: "project.ensure",
      resource_kind: "project",
      field_path: "project",
      desired: recordFrom(spec.project),
      mutation: "ensure",
      destructive: false,
      depends_on: [],
    },
  ];

  if (spec.project.origin?.subdomain !== undefined) {
    intents.push({
      id: "origin.ensure",
      resource_kind: "origin",
      logical_name: "primary",
      field_path: "project.origin",
      desired: recordFrom(spec.project.origin),
      mutation: "ensure",
      destructive: false,
      depends_on: ["project.ensure"],
    });
  }

  for (const [name, mailbox] of sortedEntries(spec.resources?.mailboxes)) {
    intents.push({
      id: `mailbox.${name}.ensure`,
      resource_kind: "mailbox",
      logical_name: name,
      field_path: `resources.mailboxes.${name}`,
      desired: recordFrom(mailbox),
      mutation: "ensure",
      destructive: false,
      depends_on: ["project.ensure"],
    });
  }

  for (const [name, webhook] of sortedEntries(spec.resources?.webhooks)) {
    const dependsOn = [`mailbox.${webhook.mailbox}.ensure`];
    if (spec.project.origin?.subdomain !== undefined) dependsOn.push("origin.ensure");
    intents.push({
      id: `webhook.${name}.ensure`,
      resource_kind: "mailbox_webhook",
      logical_name: name,
      field_path: `resources.webhooks.${name}`,
      desired: recordFrom(webhook),
      mutation: "ensure",
      destructive: false,
      depends_on: dependsOn,
    });
  }

  for (const [name, secret] of sortedEntries(spec.secrets)) {
    intents.push({
      id: `secret.${name}.ensure`,
      resource_kind: "secret",
      logical_name: name,
      field_path: `secrets.${name}`,
      desired: recordFrom(secret),
      mutation: "ensure",
      destructive: false,
      depends_on: ["project.ensure"],
    });
  }

  if (spec.build !== undefined) {
    intents.push({
      id: "build.run",
      resource_kind: "build",
      field_path: "build",
      desired: recordFrom(spec.build),
      mutation: "apply",
      destructive: false,
      depends_on: ["project.ensure"],
    });
  }

  intents.push({
    id: "release.apply",
    resource_kind: "release",
    field_path: "release",
    desired: recordFrom(spec.release),
    mutation: "apply",
    destructive: false,
    depends_on: [
      ...intents
        .filter((intent) => intent.id !== "release.apply" && intent.resource_kind !== "verify_http")
        .map((intent) => intent.id),
    ],
  });

  for (const [index, check] of (spec.verify?.http ?? []).entries()) {
    intents.push({
      id: `verify.http.${check.id}`,
      resource_kind: "verify_http",
      logical_name: check.id,
      field_path: `verify.http.${index}`,
      desired: recordFrom(check),
      mutation: "none",
      destructive: false,
      depends_on: ["release.apply"],
    });
  }

  return intents;
}

export function planRun402AppResources(
  spec: Run402AppSpec,
  adapters: readonly Run402AppResourceAdapter[],
  options: Run402AppResourcePlanOptions = {},
): Run402AppResourcePlan {
  const intents = collectRun402AppResourceIntents(spec);
  const adapterMap = adapterMapFrom(adapters);
  const context: Run402AppResourceAdapterPlanContext = {
    contract_version: RUN402_APP_RESOURCE_ADAPTER_CONTRACT_VERSION,
    app: spec.app,
    project: spec.project,
  };
  const nodes: Run402AppResourcePlanNode[] = [];
  const diagnostics: Run402AppResourceDiagnostic[] = [];
  const nextActions: Run402AppResourceNextAction[] = [];

  for (const intent of intents) {
    const adapter = adapterMap.get(intent.resource_kind);
    const result = adapter === undefined
      ? unsupportedResourceFailure(intent, options)
      : adapter.plan(intent, context);

    if (result.status === "planned") {
      nodes.push(result);
      diagnostics.push(...result.diagnostics);
      continue;
    }

    const diagnostic: Run402AppResourceDiagnostic = {
      code: result.code,
      severity: "error",
      resource: result.field_path,
      message: result.message,
      next_actions: result.next_actions,
      details: {
        resource_kind: result.resource_kind,
        alternatives: result.alternatives,
        ...result.details,
      },
    };
    diagnostics.push(diagnostic);
    nextActions.push(...result.next_actions);
  }

  const status = diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? "blocked"
    : "planned";
  const digest = computeEvaluatedPlanDigestHex({
    contract_version: RUN402_APP_RESOURCE_ADAPTER_CONTRACT_VERSION,
    intents,
    nodes,
    diagnostics,
  });

  return {
    kind: "run402.app_resource_plan",
    contract_version: RUN402_APP_RESOURCE_ADAPTER_CONTRACT_VERSION,
    status,
    graph_digest: `${RUN402_APP_RESOURCE_PLAN_DIGEST_IDENTITY}:${digest}`,
    intents,
    nodes,
    diagnostics,
    next_actions: nextActions,
  };
}

export function createStaticRun402AppResourceAdapter(
  resourceKind: Run402AppResourceKind,
  adapterId = `run402.static.${resourceKind}`,
): Run402AppResourceAdapter {
  return {
    resource_kind: resourceKind,
    adapter_id: adapterId,
    plan(intent) {
      return {
        id: intent.id,
        resource_kind: intent.resource_kind,
        logical_name: intent.logical_name,
        field_path: intent.field_path,
        adapter: adapterId,
        status: "planned",
        input_digest: `${RUN402_APP_RESOURCE_PLAN_DIGEST_IDENTITY}:${computeEvaluatedPlanDigestHex(intent)}`,
        mutation: intent.mutation,
        destructive: intent.destructive,
        depends_on: intent.depends_on,
        bindings: defaultRun402AppResourceBindings(intent),
        diagnostics: [],
      };
    },
  };
}

export function createRun402CoreAppResourceAdapters(): Run402AppResourceAdapter[] {
  return [
    createStaticRun402AppResourceAdapter("release", "run402-core.release"),
    createStaticRun402AppResourceAdapter("verify_http", "run402-core.verify_http"),
  ];
}

export function defaultRun402AppResourceBindings(
  intent: Run402AppResourceIntent,
): Run402AppResourceBinding[] {
  if (intent.resource_kind === "origin") {
    return [
      generatedBinding("RUN402_PUBLIC_ORIGIN", "generated_config_binding", ["runtime", "verify", "template"], "platform"),
    ];
  }

  if (intent.resource_kind === "project") {
    return [
      generatedBinding("RUN402_PROJECT_ID", "generated_config_binding", ["runtime", "verify", "template"], "platform"),
      generatedBinding("RUN402_API_BASE_URL", "generated_config_binding", ["runtime", "verify", "template"], "platform"),
    ];
  }

  if (intent.resource_kind === "release") {
    return [
      generatedBinding("RUN402_RELEASE_ID", "generated_config_binding", ["runtime", "verify"], "platform"),
      generatedBinding("RUN402_DEPLOYMENT_ID", "generated_config_binding", ["runtime", "verify"], "platform"),
    ];
  }

  if (intent.resource_kind === "mailbox" && intent.logical_name !== undefined) {
    const bindings = generatedMailboxBindings(intent.logical_name);
    return [
      generatedBinding(bindings.id, "generated_config_binding", ["runtime", "template"], "mailbox", intent.logical_name),
      generatedBinding(bindings.address, "generated_config_binding", ["runtime", "template"], "mailbox", intent.logical_name),
    ];
  }

  if (intent.resource_kind === "mailbox_webhook" && intent.logical_name !== undefined) {
    const signing = recordFrom(intent.desired.signing);
    if (signing.required === true) {
      return [
        generatedBinding(
          `RUN402_WEBHOOK_${bindingSuffix(intent.logical_name)}_SECRET`,
          "generated_secret_binding",
          ["runtime", "template"],
          "mailbox_webhook",
          intent.logical_name,
          true,
        ),
      ];
    }
  }

  if (intent.resource_kind === "secret" && intent.logical_name !== undefined) {
    return [
      generatedBinding(intent.logical_name, "user_secret", ["build", "runtime"], "platform", intent.logical_name, true),
    ];
  }

  return [];
}

function unsupportedResourceFailure(
  intent: Run402AppResourceIntent,
  options: Run402AppResourcePlanOptions,
): Run402AppResourcePlanFailure {
  const alternatives = options.unsupported_alternatives?.[intent.resource_kind] ?? [];
  return {
    status: "blocked",
    code: RUN402_APP_UNSUPPORTED_RESOURCE_KIND_CODE,
    resource_kind: intent.resource_kind,
    field_path: intent.field_path,
    message: `No app resource adapter is available for ${intent.resource_kind} at ${intent.field_path}`,
    alternatives,
    next_actions: [
      {
        kind: alternatives.length > 0 ? "switch_runtime" : "choose_adapter",
        label: alternatives.length > 0
          ? `Use an adapter/runtime that supports ${intent.resource_kind}`
          : `Provide an adapter for ${intent.resource_kind}`,
        docs_url: "https://run402.com/docs/app-up",
        details: {
          resource_kind: intent.resource_kind,
          field_path: intent.field_path,
          alternatives,
        },
      },
      {
        kind: "remove_resource",
        label: `Remove ${intent.field_path} from run402.json if this resource is not required`,
        details: {
          field_path: intent.field_path,
        },
      },
    ],
  };
}

function adapterMapFrom(
  adapters: readonly Run402AppResourceAdapter[],
): Map<Run402AppResourceKind, Run402AppResourceAdapter> {
  const map = new Map<Run402AppResourceKind, Run402AppResourceAdapter>();
  for (const adapter of adapters) {
    if (map.has(adapter.resource_kind)) {
      throw new ReleaseSpecValidationError(
        `adapters.${adapter.resource_kind}`,
        `duplicate app resource adapter for ${adapter.resource_kind}`,
      );
    }
    map.set(adapter.resource_kind, adapter);
  }
  return map;
}

function generatedBinding(
  env: string,
  bindingClass: Run402BindingClass,
  scopes: Run402BindingScope[],
  source: Run402AppResourceKind | "platform",
  logicalName?: string,
  redacted = false,
): Run402AppResourceBinding {
  return {
    env,
    binding_class: bindingClass,
    scopes,
    source,
    logical_name: logicalName,
    redacted,
  };
}

function sortedEntries<T>(value: Record<string, T> | undefined): Array<[string, T]> {
  return Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

function recordFrom(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function bindingSuffix(value: string): string {
  return value.toUpperCase();
}
