const baseUrl = process.env.CORE_SMOKE_BASE_URL || "http://127.0.0.1:4020";

const createResponse = await fetch(`${baseUrl}/projects/v1`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({ name: "core-smoke" }),
});

if (!createResponse.ok) {
  throw new Error(`Project create failed: ${createResponse.status} ${await createResponse.text()}`);
}

const project = await createResponse.json();
if (!project.project_id || !project.anon_key || !project.service_key || !project.schema_slot) {
  throw new Error(`Project create returned an incomplete project: ${JSON.stringify(project)}`);
}

const inspectResponse = await fetch(`${baseUrl}/projects/v1/${project.project_id}`);
if (!inspectResponse.ok) {
  throw new Error(`Project inspect failed: ${inspectResponse.status} ${await inspectResponse.text()}`);
}

const inspected = await inspectResponse.json();
if (inspected.project_id !== project.project_id) {
  throw new Error(`Project inspect returned the wrong project: ${JSON.stringify(inspected)}`);
}

console.log(JSON.stringify({
  status: "ok",
  project_id: project.project_id,
  schema_slot: project.schema_slot,
  rest_url: project.endpoints?.rest_url,
  static_base_url: project.endpoints?.static_base_url,
}, null, 2));
