import { spawn } from "node:child_process";
import pg from "pg";

const { Pool } = pg;
const baseUrl = process.env.CORE_SMOKE_BASE_URL || "http://127.0.0.1:4020";
const fixtureRoot = process.env.CORE_ARCHIVE_FIXTURE_ROOT || "/app/fixtures/portable-project-archive-core";
const archivePath = process.env.CORE_ARCHIVE_FIXTURE_PATH || `${fixtureRoot}/archive`;
const databaseUrl = process.env.CORE_SMOKE_DATABASE_URL || "postgres://run402_core:run402_core_dev@127.0.0.1:55432/run402_core";
const importName = process.env.CORE_ARCHIVE_IMPORT_NAME || `portable-archive-smoke-${Date.now()}`;

const imported = await postJson("/archives/v1/import", {
  archive_path: archivePath,
  name: importName,
  require_runnable: true,
  secret_values: {
    OPENAI_API_KEY: "present",
  },
});

if (imported.status !== "imported" || !imported.project_id) {
  throw new Error(`Archive import did not create a project: ${JSON.stringify(imported)}`);
}

const project = await getJson(`/projects/v1/${imported.project_id}`);
if (project.active_release_id !== "rel_public_portable_archive_fixture_v1") {
  throw new Error(`Imported project has wrong active release: ${JSON.stringify(project)}`);
}

const staticResponse = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/index.html`);
if (!staticResponse.ok) {
  throw new Error(`Imported static fetch failed: ${staticResponse.status} ${await staticResponse.text()}`);
}
const staticText = await staticResponse.text();
if (!staticText.includes("Portable archive fixture")) {
  throw new Error(`Imported static response did not match fixture: ${staticText}`);
}

const publicObject = await fetch(`${baseUrl}/projects/v1/${project.project_id}/storage/public/objects/public.txt`);
if (!publicObject.ok) {
  throw new Error(`Imported storage public object failed: ${publicObject.status} ${await publicObject.text()}`);
}
const objectText = await publicObject.text();
if (!objectText.includes("public object from archive fixture")) {
  throw new Error(`Imported storage object did not match fixture: ${objectText}`);
}

const functionResponse = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/api`);
if (!functionResponse.ok) {
  throw new Error(`Imported routed function failed: ${functionResponse.status} ${await functionResponse.text()}`);
}
const functionText = await functionResponse.text();
if (!functionText.includes("hello from portable archive function")) {
  throw new Error(`Imported routed function did not match fixture: ${functionText}`);
}

const ssrResponse = await fetch(`${baseUrl}/projects/v1/${project.project_id}/static/some-ssr-path`);
if (!ssrResponse.ok) {
  throw new Error(`Imported Astro SSR route failed: ${ssrResponse.status} ${await ssrResponse.text()}`);
}
const ssrText = await ssrResponse.text();
if (!ssrText.includes("astro ssr fixture")) {
  throw new Error(`Imported Astro SSR route did not match fixture: ${ssrText}`);
}

const aliceToken = await postJson("/auth/v1/dev-tokens", {
  project_id: project.project_id,
  role: "authenticated",
  sub: "auth_subject_alice",
});
const bobToken = await postJson("/auth/v1/dev-tokens", {
  project_id: project.project_id,
  role: "authenticated",
  sub: "auth_subject_bob",
});
const serviceToken = await postJson("/auth/v1/dev-tokens", {
  project_id: project.project_id,
  role: "service_role",
  sub: "service",
});

const anonRows = await getRestRows(project, "/todos?select=id,owner_id,title&id=eq.1");
if (anonRows.length !== 0) {
  throw new Error(`Expected anon RLS denial, got ${JSON.stringify(anonRows)}`);
}

const aliceRows = await getRestRows(project, "/todos?select=id,owner_id,title&id=eq.1", aliceToken.authorization);
if (aliceRows.length !== 1 || aliceRows[0].owner_id !== "auth_subject_alice") {
  throw new Error(`Expected Alice to read her row, got ${JSON.stringify(aliceRows)}`);
}

const bobRows = await getRestRows(project, "/todos?select=id,owner_id,title&id=eq.1", bobToken.authorization);
if (bobRows.length !== 0) {
  throw new Error(`Expected Bob to be denied Alice row, got ${JSON.stringify(bobRows)}`);
}

const serviceRows = await getRestRows(project, "/todos?select=id,owner_id,title", serviceToken.authorization);
if (serviceRows.length !== 2) {
  throw new Error(`Expected service role to read all imported rows, got ${JSON.stringify(serviceRows)}`);
}

const aliceComments = await getRestRows(project, "/comments?select=id,todo_id,body&todo_id=eq.1", aliceToken.authorization);
if (aliceComments.length !== 1 || !aliceComments[0].body.includes("Alice-only comment")) {
  throw new Error(`Expected Alice to read her imported FK comment, got ${JSON.stringify(aliceComments)}`);
}

const bobAliceComments = await getRestRows(project, "/comments?select=id,todo_id,body&todo_id=eq.1", bobToken.authorization);
if (bobAliceComments.length !== 0) {
  throw new Error(`Expected Bob to be denied Alice's FK comment, got ${JSON.stringify(bobAliceComments)}`);
}

const insertedTodo = await postRestRows(project, "/todos?select=id,owner_id,title", {
  owner_id: "auth_subject_alice",
  title: "Inserted after archive import",
}, serviceToken.authorization);
if (insertedTodo.length !== 1 || insertedTodo[0].id !== 3) {
  throw new Error(`Expected restored todo sequence to allocate id 3, got ${JSON.stringify(insertedTodo)}`);
}

const auditRows = await getRestRows(
  project,
  `/todo_audit?select=event,todo_id,owner_id&todo_id=eq.${insertedTodo[0].id}`,
  serviceToken.authorization,
);
if (auditRows.length !== 1 || auditRows[0].event !== "insert") {
  throw new Error(`Expected imported trigger to write audit row, got ${JSON.stringify(auditRows)}`);
}

await assertIndexExists(project.schema_slot, "todos_owner_id_idx");
await assertIndexExists(project.schema_slot, "comments_todo_id_idx");
await assertTableOwner(project.schema_slot, "todos", "run402_archive_importer");

await expectArchiveImportFailure(archivePath, importName, 422, "PROJECT_ALREADY_EXISTS");

const importFailureCases = [
  ["unsafe-database-sql", "DATABASE_SCHEMA_UNSAFE"],
  ["unsupported-extension", "DATABASE_EXTENSION_UNSUPPORTED"],
  ["unsupported-table-schema", "DATABASE_SCHEMA_UNSAFE"],
  ["credential-auth-export", "AUTH_CREDENTIALS_NOT_EXPORTED"],
];
for (const [fixtureName, expectedError] of importFailureCases) {
  const rollbackProjectName = `portable-archive-rollback-${fixtureName}-${Date.now()}`;
  await expectArchiveImportFailure(
    `${fixtureRoot}/import-failure/${fixtureName}`,
    rollbackProjectName,
    422,
    expectedError,
  );
  await assertNoProjectNamed(rollbackProjectName);
}

const restartChecks = [];
if (process.env.CORE_ARCHIVE_RESTART_CHECK === "1") {
  await restartCoreServices();
  await waitForCoreHealth();
  await expectTextWithRetry(
    `${baseUrl}/projects/v1/${project.project_id}/static/index.html`,
    "Portable archive fixture",
    "static-after-restart",
  );
  await expectTextWithRetry(
    `${baseUrl}/projects/v1/${project.project_id}/static/api`,
    "hello from portable archive function",
    "function-after-restart",
  );
  await expectTextWithRetry(
    `${baseUrl}/projects/v1/${project.project_id}/static/some-ssr-path`,
    "astro ssr fixture",
    "ssr-after-restart",
  );
  const aliceRowsAfterRestart = await getRestRows(project, "/todos?select=id,owner_id,title&id=eq.1", aliceToken.authorization);
  if (aliceRowsAfterRestart.length !== 1 || aliceRowsAfterRestart[0].owner_id !== "auth_subject_alice") {
    throw new Error(`Expected Alice RLS to persist after restart, got ${JSON.stringify(aliceRowsAfterRestart)}`);
  }
  restartChecks.push("static", "function", "astro-ssr", "rest-rls");
}

console.log(JSON.stringify({
  status: "ok",
  project_id: project.project_id,
  release_id: project.active_release_id,
  archive_digest: imported.archive_digest,
  routes: {
    function: functionText,
    ssr: ssrText,
  },
  rls_rows: {
    anon: anonRows.length,
    alice: aliceRows.length,
    bob: bobRows.length,
    service: serviceRows.length,
  },
  database_checks: [
    "foreign-key-copy",
    "sequence-restore",
    "post-data-trigger",
    "post-data-indexes",
    "restricted-import-role",
    "duplicate-name-rejection",
    "unsafe-sql-rollback",
    "unsupported-extension-rollback",
    "unsupported-schema-rollback",
    "credential-auth-export-rejection",
  ],
  restart_checks: restartChecks,
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

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function getRestRows(project, path, authorization) {
  let lastStatus = 0;
  let lastText = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
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

async function postRestRows(project, path, body, authorization) {
  const response = await fetch(`${project.endpoints.rest_url}${path}`, {
    method: "POST",
    headers: {
      "accept-profile": project.schema_slot,
      "content-profile": project.schema_slot,
      "content-type": "application/json",
      "prefer": "return=representation",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`REST insert failed: ${response.status} ${text}`);
  }
  return JSON.parse(text);
}

async function expectArchiveImportFailure(archive_path, name, expectedStatus, expectedError) {
  const response = await fetch(`${baseUrl}/archives/v1/import`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      archive_path,
      name,
      require_runnable: true,
      secret_values: {
        OPENAI_API_KEY: "present",
      },
    }),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`Expected archive import failure ${expectedStatus}, got ${response.status} ${text}`);
  }
  const parsed = JSON.parse(text);
  if (parsed.error !== expectedError) {
    throw new Error(`Expected archive import error ${expectedError}, got ${text}`);
  }
}

async function assertNoProjectNamed(name) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query("SELECT count(*)::int AS count FROM internal.core_projects WHERE name = $1", [name]);
    if (result.rows[0]?.count !== 0) {
      throw new Error(`Expected failed archive import to roll back project ${name}.`);
    }
  } finally {
    await pool.end();
  }
}

async function assertIndexExists(schema, indexName) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query(
      "SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = $1 AND indexname = $2",
      [schema, indexName],
    );
    if (result.rows[0]?.count !== 1) {
      throw new Error(`Expected imported index ${schema}.${indexName} to exist.`);
    }
  } finally {
    await pool.end();
  }
}

async function assertTableOwner(schema, tableName, ownerName) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query(
      `
        SELECT role.rolname AS owner
        FROM pg_class cls
        JOIN pg_namespace ns ON ns.oid = cls.relnamespace
        JOIN pg_roles role ON role.oid = cls.relowner
        WHERE ns.nspname = $1 AND cls.relname = $2 AND cls.relkind = 'r'
      `,
      [schema, tableName],
    );
    if (result.rows[0]?.owner !== ownerName) {
      throw new Error(`Expected imported table ${schema}.${tableName} owner ${ownerName}, got ${result.rows[0]?.owner}`);
    }
  } finally {
    await pool.end();
  }
}

async function restartCoreServices() {
  await runCommand("docker", ["compose", "restart", "core", "function-worker", "postgrest"]);
}

async function waitForCoreHealth() {
  let lastError = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Core did not become healthy after restart: ${lastError}`);
}

async function expectTextWithRetry(url, expectedText, label) {
  let lastStatus = 0;
  let lastText = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(url);
    lastStatus = response.status;
    lastText = await response.text();
    if (response.ok && lastText.includes(expectedText)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Expected ${label} response to include ${expectedText}, got ${lastStatus} ${lastText}`);
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: new URL("..", import.meta.url),
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}`));
    });
  });
}
