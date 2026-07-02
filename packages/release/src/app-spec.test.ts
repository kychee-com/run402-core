import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RUN402_APP_SCHEMA_ID,
  RUN402_APP_SCHEMA_VERSION,
  RUN402_APP_SPEC_VERSION,
  RUN402_APP_MANIFEST_FILENAME,
  RUN402_RELEASE_MANIFEST_FILENAME,
  generatedMailboxBindings,
  parseRun402AppSpec,
  validateRun402AppSpec,
  ReleaseSpecValidationError,
  type Run402AppSpec,
} from "./index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = "a".repeat(64);

function fullAppSpec(): Run402AppSpec {
  return {
    $schema: RUN402_APP_SCHEMA_ID,
    spec_version: 1,
    app: {
      id: "kysigned",
      display_name: "Kysigned",
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
        notifications: {
          roles: ["default_outbound"],
        },
      },
    },
    secrets: {
      KYSIGNED_ALLOWED_CREATORS: {
        required: true,
        source_env: "KYSIGNED_ALLOWED_CREATORS",
        description: "Allowed request creators. Comma-separated emails or domain wildcards such as *@example.com.",
      },
    },
    build: {
      mode: "remote",
      commands: [
        { id: "install", argv: ["npm", "ci"] },
        { id: "build", argv: ["npm", "run", "build:run402-cloud"] },
      ],
    },
    release: {
      functions: {
        replace: {
          api: {
            runtime: "node22",
            source: {
              sha256: SHA,
              size: 42,
            },
            triggers: [
              {
                id: "forward-to-sign",
                type: "email",
                mailbox: "${RUN402_MAILBOX_FORWARD_TO_SIGN_ID}",
                events: ["reply_received"],
                run: { event_type: "kysigned.email.received" },
              },
            ],
          },
        },
      },
      site: {
        replace: {
          "index.html": {
            sha256: SHA,
            size: 12,
            contentType: "text/html",
          },
        },
      },
      routes: {
        replace: [
          {
            pattern: "/v1/health",
            methods: ["GET"],
            target: { type: "function", name: "api" },
          },
        ],
      },
    },
    lifecycle: {
      project: "per_app",
      prune: "approval_required",
    },
    verify: {
      http: [
        {
          id: "home",
          path: "/",
          expect: { status: 200 },
          retries: 6,
        },
      ],
    },
  };
}

describe("Run402AppSpec", () => {
  it("exports the canonical app manifest contract identifiers", () => {
    assert.equal(RUN402_APP_MANIFEST_FILENAME, "run402.json");
    assert.equal(RUN402_RELEASE_MANIFEST_FILENAME, "run402.release.json");
    assert.equal(RUN402_APP_SPEC_VERSION, 1);
    assert.equal(RUN402_APP_SCHEMA_VERSION, "run402.app_spec.v1");
    assert.equal(RUN402_APP_SCHEMA_ID, "https://run402.com/schemas/run402-app.v1.schema.json");
  });

  it("parses a full top-level app manifest and preserves release as a node", () => {
    const parsed = parseRun402AppSpec(fullAppSpec());

    assert.equal(parsed.app.id, "kysigned");
    assert.equal(parsed.resources?.mailboxes?.forward_to_sign?.roles?.[0], "auth_sender");
    assert.equal(parsed.release.functions?.replace?.api?.triggers?.[0]?.mailbox, "${RUN402_MAILBOX_FORWARD_TO_SIGN_ID}");
    assert.equal(parsed.release.functions?.replace?.api?.runtime, "node22");
  });

  it("ships the public run402 app JSON Schema from the release package", async () => {
    const raw = await readFile(resolve(packageRoot, "schemas", "run402-app.v1.schema.json"), "utf8");
    const parsed = JSON.parse(raw) as { $schema?: string; $id?: string; additionalProperties?: boolean };

    assert.equal(parsed.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(parsed.$id, RUN402_APP_SCHEMA_ID);
    assert.equal(parsed.additionalProperties, false);
  });

  it("rejects unknown app fields before mutation", () => {
    const spec = { ...fullAppSpec(), resorces: {} };

    assert.throws(
      () => validateRun402AppSpec(spec as unknown as Run402AppSpec),
      (err) => err instanceof ReleaseSpecValidationError &&
        err.resource === "resorces" &&
        /unknown key/.test(err.message),
    );
  });

  it("rejects invalid logical resource names before mutation", () => {
    const spec = fullAppSpec();
    spec.resources = {
      mailboxes: {
        "forward-sign": {},
      },
    };

    assert.throws(
      () => validateRun402AppSpec(spec),
      (err) => err instanceof ReleaseSpecValidationError &&
        err.resource === "resources.mailboxes.forward-sign" &&
        /logical resource name/.test(err.message),
    );
  });

  it("rejects RUN402-prefixed user secrets", () => {
    const spec = fullAppSpec();
    spec.secrets = {
      RUN402_PROJECT_ID: {
        required: true,
      },
    };

    assert.throws(
      () => validateRun402AppSpec(spec),
      (err) => err instanceof ReleaseSpecValidationError &&
        err.resource === "secrets.RUN402_PROJECT_ID" &&
        /reserved/.test(err.message),
    );
  });

  it("rejects unresolved webhook URL template references before mutation", () => {
    const spec = fullAppSpec();
    spec.resources = {
      mailboxes: {
        signing: {},
      },
      webhooks: {
        inbound_email: {
          mailbox: "signing",
          url: "${CUSTOM_DOMAIN}/v1/webhooks/inbound",
          events: ["reply_received"],
        },
      },
    };

    assert.throws(
      () => validateRun402AppSpec(spec),
      (err) => err instanceof ReleaseSpecValidationError &&
        err.resource === "resources.webhooks.inbound_email.url" &&
        /unresolved template reference/.test(err.message),
    );
  });

  it("rejects unresolved release email trigger mailbox bindings before mutation", () => {
    const spec = fullAppSpec();
    spec.release.functions!.replace!.api!.triggers![0]!.mailbox = "${RUN402_MAILBOX_UNKNOWN_ID}";

    assert.throws(
      () => validateRun402AppSpec(spec),
      (err) => err instanceof ReleaseSpecValidationError &&
        err.resource === "release.functions.replace.api.triggers.0.mailbox" &&
        /unresolved template reference/.test(err.message),
    );
  });

  it("keeps release-only schema scoped away from app-only fields", () => {
    assert.throws(
      () => validateRun402AppSpec({
        ...fullAppSpec(),
        release: {
          project: "prj_123",
          build: { commands: [] },
        },
      } as unknown as Run402AppSpec),
      (err) => err instanceof ReleaseSpecValidationError &&
        err.resource === "release.project" &&
        /app install graph/.test(err.message),
    );
  });

  it("derives canonical generated mailbox bindings from logical names", () => {
    assert.deepEqual(generatedMailboxBindings("forward_to_sign"), {
      id: "RUN402_MAILBOX_FORWARD_TO_SIGN_ID",
      address: "RUN402_MAILBOX_FORWARD_TO_SIGN_ADDRESS",
    });
  });
});
