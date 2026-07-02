import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RUN402_APP_RESOURCE_ADAPTER_CONTRACT_VERSION,
  RUN402_APP_RESOURCE_PLAN_DIGEST_IDENTITY,
  RUN402_APP_UNSUPPORTED_RESOURCE_KIND_CODE,
  collectRun402AppResourceIntents,
  createRun402CoreAppResourceAdapters,
  createStaticRun402AppResourceAdapter,
  defaultRun402AppResourceBindings,
  planRun402AppResources,
  type Run402AppResourceKind,
  type Run402AppSpec,
} from "./index.js";

const SHA = "b".repeat(64);

function appSpec(): Run402AppSpec {
  return {
    $schema: "https://run402.com/schemas/run402-app.v1.schema.json",
    spec_version: 1,
    app: {
      id: "mailhook",
      display_name: "Mailhook",
    },
    project: {
      name: "${input.name}",
      origin: {
        subdomain: "${input.name}",
      },
    },
    resources: {
      mailboxes: {
        forward_to_sign: {
          roles: ["auth_sender"],
        },
      },
      webhooks: {
        inbound_email: {
          mailbox: "forward_to_sign",
          url: "${RUN402_PUBLIC_ORIGIN}/v1/webhooks/inbound",
          events: ["reply_received"],
          signing: {
            required: true,
          },
        },
      },
    },
    secrets: {
      KYSIGNED_ALLOWED_CREATORS: {
        required: true,
      },
    },
    build: {
      mode: "remote",
      commands: [
        { id: "build", argv: ["npm", "run", "build"] },
      ],
    },
    release: {
      functions: {
        replace: {
          api: {
            runtime: "node22",
            source: { sha256: SHA, size: 42 },
          },
        },
      },
    },
    verify: {
      http: [
        {
          id: "home",
          path: "/",
          expect: { status: 200 },
        },
      ],
    },
  };
}

function adaptersWithoutMailbox(): ReturnType<typeof createStaticRun402AppResourceAdapter>[] {
  const kinds: Run402AppResourceKind[] = [
    "project",
    "origin",
    "mailbox_webhook",
    "secret",
    "build",
    "release",
    "verify_http",
  ];
  return kinds.map((kind) => createStaticRun402AppResourceAdapter(kind, `test.${kind}`));
}

describe("Run402 app resource adapters", () => {
  it("collects deterministic resource intents from an app spec", () => {
    const intents = collectRun402AppResourceIntents(appSpec());

    assert.deepEqual(intents.map((intent) => intent.id), [
      "project.ensure",
      "origin.ensure",
      "mailbox.forward_to_sign.ensure",
      "webhook.inbound_email.ensure",
      "secret.KYSIGNED_ALLOWED_CREATORS.ensure",
      "build.run",
      "release.apply",
      "verify.http.home",
    ]);
    assert.equal(intents[2]?.field_path, "resources.mailboxes.forward_to_sign");
    assert.deepEqual(intents.at(-1)?.depends_on, ["release.apply"]);
  });

  it("blocks at plan time when a resource kind has no adapter", () => {
    const plan = planRun402AppResources(appSpec(), adaptersWithoutMailbox(), {
      unsupported_alternatives: {
        mailbox: ["run402-cloud"],
      },
    });

    assert.equal(plan.contract_version, RUN402_APP_RESOURCE_ADAPTER_CONTRACT_VERSION);
    assert.equal(plan.status, "blocked");
    assert.match(plan.graph_digest, new RegExp(`^${RUN402_APP_RESOURCE_PLAN_DIGEST_IDENTITY}:`));
    assert.equal(plan.diagnostics[0]?.code, RUN402_APP_UNSUPPORTED_RESOURCE_KIND_CODE);
    assert.equal(plan.diagnostics[0]?.resource, "resources.mailboxes.forward_to_sign");
    assert.equal(plan.next_actions[0]?.kind, "switch_runtime");
    assert.deepEqual(plan.next_actions[0]?.details?.alternatives, ["run402-cloud"]);
  });

  it("makes Run402 Core reject Cloud-only resources instead of ignoring them", () => {
    const plan = planRun402AppResources(appSpec(), createRun402CoreAppResourceAdapters());
    const resources = plan.diagnostics.map((diagnostic) => diagnostic.resource);

    assert.equal(plan.status, "blocked");
    assert.ok(resources.includes("resources.mailboxes.forward_to_sign"));
    assert.ok(resources.includes("project"));
  });

  it("declares binding classes and scopes for generated and user bindings", () => {
    const intents = collectRun402AppResourceIntents(appSpec());
    const mailbox = intents.find((intent) => intent.resource_kind === "mailbox");
    const webhook = intents.find((intent) => intent.resource_kind === "mailbox_webhook");
    const secret = intents.find((intent) => intent.resource_kind === "secret");

    assert.deepEqual(defaultRun402AppResourceBindings(mailbox ?? intents[0]!).map((binding) => ({
      env: binding.env,
      binding_class: binding.binding_class,
      scopes: binding.scopes,
    })), [
      {
        env: "RUN402_MAILBOX_FORWARD_TO_SIGN_ID",
        binding_class: "generated_config_binding",
        scopes: ["runtime", "template"],
      },
      {
        env: "RUN402_MAILBOX_FORWARD_TO_SIGN_ADDRESS",
        binding_class: "generated_config_binding",
        scopes: ["runtime", "template"],
      },
    ]);
    assert.deepEqual(defaultRun402AppResourceBindings(webhook ?? intents[0]!)[0], {
      env: "RUN402_WEBHOOK_INBOUND_EMAIL_SECRET",
      binding_class: "generated_secret_binding",
      scopes: ["runtime", "template"],
      source: "mailbox_webhook",
      logical_name: "inbound_email",
      redacted: true,
    });
    assert.equal(defaultRun402AppResourceBindings(secret ?? intents[0]!)[0]?.binding_class, "user_secret");
  });
});
