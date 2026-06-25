import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const baseUrl = process.env.CORE_SMOKE_BASE_URL || "http://127.0.0.1:4020";
const fixtureDir = new URL("../fixtures/runtime-kernel-static-rest/", import.meta.url);

const project = await postJson("/projects/v1", { name: "core-apply-smoke" });
const html = await readFile(new URL("site/index.html", fixtureDir));
const htmlSha = sha256Hex(html);

await postJson(`/projects/v1/${project.project_id}/content`, {
  sha256: htmlSha,
  size: html.byteLength,
  content_type: "text/html",
  bytes_base64: html.toString("base64"),
});

const migrationSql = await readFile(new URL("migrations/001_smoke_todos.sql", fixtureDir), "utf8");
const spec = {
  project: project.project_id,
  base: { release: "current" },
  database: {
    migrations: [
      {
        id: "001_smoke_todos",
        checksum: sha256Hex(migrationSql),
        sql: migrationSql,
      },
    ],
  },
  site: {
    replace: {
      "index.html": {
        sha256: htmlSha,
        size: html.byteLength,
        contentType: "text/html",
      },
    },
    public_paths: {
      mode: "explicit",
      replace: {
        "/": { asset: "index.html" },
      },
    },
  },
};

const plan = await postJson("/apply/v1/plans", { spec });
const commit = await postJson(`/apply/v1/plans/${plan.plan_id}/commit`, {
  release_spec_digest: plan.release_spec_digest,
});
if (commit.status !== "committed") {
  throw new Error(`Expected committed apply, got ${JSON.stringify(commit)}`);
}

const staticResponse = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/`);
if (!staticResponse.ok) {
  throw new Error(`Static fetch failed: ${staticResponse.status} ${await staticResponse.text()}`);
}
const served = Buffer.from(await staticResponse.arrayBuffer());
if (sha256Hex(served) !== htmlSha) {
  throw new Error("Served static bytes did not match staged digest.");
}

const userAToken = await postJson("/auth/v1/dev-tokens", {
  project_id: project.project_id,
  role: "authenticated",
  sub: "user_a",
});
const userBToken = await postJson("/auth/v1/dev-tokens", {
  project_id: project.project_id,
  role: "authenticated",
  sub: "user_b",
});
const serviceToken = await postJson("/auth/v1/dev-tokens", {
  project_id: project.project_id,
  role: "service_role",
  sub: "service",
});

const anonRows = await getRestRows(project, "/smoke_todos?select=id,owner_id,title&id=eq.todo_a");
if (anonRows.length !== 0) {
  throw new Error(`Expected anon RLS denial as empty rows, got ${JSON.stringify(anonRows)}`);
}

const userARows = await getRestRows(project, "/smoke_todos?select=id,owner_id,title&id=eq.todo_a", userAToken.authorization);
if (userARows.length !== 1 || userARows[0].owner_id !== "user_a") {
  throw new Error(`Expected user A to read own row, got ${JSON.stringify(userARows)}`);
}

const userBRows = await getRestRows(project, "/smoke_todos?select=id,owner_id,title&id=eq.todo_a", userBToken.authorization);
if (userBRows.length !== 0) {
  throw new Error(`Expected user B to be denied user A row, got ${JSON.stringify(userBRows)}`);
}

const serviceRows = await getRestRows(project, "/smoke_todos?select=id,owner_id,title", serviceToken.authorization);
if (serviceRows.length < 2) {
  throw new Error(`Expected service role to read all rows, got ${JSON.stringify(serviceRows)}`);
}

await expectPostJsonFailure("/apply/v1/plans", {
  spec: {
    project: project.project_id,
    functions: {
      replace: {
        api: { runtime: "node22" },
      },
    },
  },
}, 422, "unsupported_capability");

const missingContentPlan = await postJson("/apply/v1/plans", {
  spec: {
    project: project.project_id,
    site: {
      replace: {
        "missing.html": {
          sha256: "0".repeat(64),
          size: 10,
          contentType: "text/html",
        },
      },
      public_paths: {
        mode: "explicit",
        replace: {
          "/": { asset: "missing.html" },
        },
      },
    },
  },
});
await expectPostJsonFailure(`/apply/v1/plans/${missingContentPlan.plan_id}/commit`, {
  release_spec_digest: missingContentPlan.release_spec_digest,
}, 409, "content_digest_missing");

const noopPlan = await postJson("/apply/v1/plans", { spec });
if (noopPlan.noop !== true) {
  throw new Error(`Expected reapply plan to be noop, got ${JSON.stringify(noopPlan)}`);
}
const noopCommit = await postJson(`/apply/v1/plans/${noopPlan.plan_id}/commit`, {
  release_spec_digest: noopPlan.release_spec_digest,
});
if (noopCommit.status !== "noop") {
  throw new Error(`Expected noop commit, got ${JSON.stringify(noopCommit)}`);
}

const staleHtml = Buffer.from("<!doctype html><title>Run402 Core stale plan</title>\n", "utf8");
const staleSpec = await stageStaticSpec(project, "stale.html", staleHtml);
const stalePlan = await postJson("/apply/v1/plans", { spec: staleSpec });
const advanceHtml = Buffer.from("<!doctype html><title>Run402 Core advanced release</title>\n", "utf8");
const advanceSpec = await stageStaticSpec(project, "advanced.html", advanceHtml);
const advancePlan = await postJson("/apply/v1/plans", { spec: advanceSpec });
await postJson(`/apply/v1/plans/${advancePlan.plan_id}/commit`, {
  release_spec_digest: advancePlan.release_spec_digest,
});
await expectPostJsonFailure(`/apply/v1/plans/${stalePlan.plan_id}/commit`, {
  release_spec_digest: stalePlan.release_spec_digest,
}, 409, "stale_plan");
const restorePlan = await postJson("/apply/v1/plans", { spec });
await postJson(`/apply/v1/plans/${restorePlan.plan_id}/commit`, {
  release_spec_digest: restorePlan.release_spec_digest,
});

console.log(JSON.stringify({
  status: "ok",
  project_id: project.project_id,
  plan_id: plan.plan_id,
  release_id: commit.release_id,
  rest_schema: project.schema_slot,
  rls_rows: {
    anon: anonRows.length,
    user_a: userARows.length,
    user_b: userBRows.length,
    service: serviceRows.length,
  },
  invariant_checks: [
    "unsupported_capability",
    "content_digest_missing",
    "stale_plan"
  ],
  noop_plan_id: noopPlan.plan_id,
  restore_plan_id: restorePlan.plan_id,
}, null, 2));

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function expectPostJsonFailure(path, body, expectedStatus, expectedError) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`Expected POST ${path} to fail with ${expectedStatus}, got ${response.status} ${text}`);
  }
  const parsed = JSON.parse(text);
  if (parsed.error !== expectedError) {
    throw new Error(`Expected POST ${path} error ${expectedError}, got ${text}`);
  }
}

async function stageStaticSpec(project, assetPath, bytes) {
  const digest = sha256Hex(bytes);
  await postJson(`/projects/v1/${project.project_id}/content`, {
    sha256: digest,
    size: bytes.byteLength,
    content_type: "text/html",
    bytes_base64: bytes.toString("base64"),
  });
  return {
    project: project.project_id,
    site: {
      replace: {
        [assetPath]: {
          sha256: digest,
          size: bytes.byteLength,
          contentType: "text/html",
        },
      },
      public_paths: {
        mode: "explicit",
        replace: {
          "/": { asset: assetPath },
        },
      },
    },
  };
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function getRestRows(project, path, authorization) {
  let lastStatus = 0;
  let lastText = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${project.endpoints.rest_url}${path}`, {
      headers: {
        "accept-profile": project.schema_slot,
        ...(authorization ? { authorization } : {}),
      },
    });
    lastStatus = response.status;
    lastText = await response.text();
    if (response.ok) {
      return JSON.parse(lastText);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`REST query failed after retries: ${lastStatus} ${lastText}`);
}
