import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
const base = process.env.CORE_SMOKE_BASE_URL || 'http://127.0.0.1:4020';
const db = process.env.CORE_SMOKE_DATABASE_URL || 'postgres://run402_core:run402_core_dev@127.0.0.1:55432/run402_core';
async function post(path, body) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.ok, true, await response.clone().text());
  return response.json();
}
const project = await post('/projects/v1', { name: 'static-continuity-conformance' });
const script = Buffer.from('export const release = "A";');
async function file(bytes, type) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await post(`/projects/v1/${project.project_id}/content`, { sha256, size: bytes.length, content_type: type, bytes_base64: bytes.toString('base64') });
  return { sha256, size: bytes.length, contentType: type };
}
const chunk = await file(script, 'application/javascript');
async function deploy(name, includeChunk) {
  const html = await file(Buffer.from(`<h1>${name}</h1>`), 'text/html');
  const plan = await post('/apply/v1/plans', { spec: { project: project.project_id, base: { release: 'current' }, site: {
    replace: { 'index.html': html, ...(includeChunk ? { 'private/source.js': chunk } : {}) },
    public_paths: { mode: 'explicit', replace: { '/': { asset: 'index.html' }, ...(includeChunk ? { '/download': { asset: 'private/source.js' } } : {}) } },
  } } });
  return post(`/apply/v1/plans/${plan.plan_id}/commit`, { release_spec_digest: plan.release_spec_digest });
}
const a = await deploy('A', true);
await deploy('B', false);
const prefix = `${base}/projects/v1/${project.project_id}/static`;
const retained = await fetch(prefix + '/download');
assert.equal(retained.status, 200);
assert.equal(await retained.text(), script.toString());
assert.equal(retained.headers.get('x-run402-release-id'), a.release_id);
assert.equal((await fetch(prefix + '/private/source.js')).status, 404);
assert.match(await (await fetch(prefix + '/')).text(), /B/);
const pool = new pg.Pool({ connectionString: db });
try {
  await pool.query('UPDATE internal.core_retained_static SET origin_available_until = NOW() WHERE project_id = $1', [project.project_id]);
  assert.equal((await fetch(prefix + '/download')).status, 404);
} finally { await pool.end(); }
console.log(JSON.stringify({ static_continuity: 'passed', checks: ['effective-history', 'public-alias', 'private-path-denial', 'current-wins', 'source-header', 'origin-expiry'] }));
