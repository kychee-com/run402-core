import type { PoolClient } from 'pg';
import type { PortableReleaseState } from '@run402/release';
import { isRetainablePublicEntry } from '@run402/runtime-kernel';

/** Call under the same project row lock and transaction as either activation adapter. */
export async function retainCorePublicPaths(client: PoolClient, input: { projectId: string; expectedBaseReleaseId: string | null; releaseId: string }): Promise<void> {
  if (input.expectedBaseReleaseId && input.expectedBaseReleaseId !== input.releaseId) {
    const old = await client.query<{ state: PortableReleaseState }>('SELECT state FROM internal.core_releases WHERE project_id = $1 AND release_id = $2', [input.projectId, input.expectedBaseReleaseId]);
    const entries = Object.entries(old.rows[0]?.state.static_manifest?.files ?? {})
      .filter(([path, entry]) => isRetainablePublicEntry(path, entry))
      .map(([public_path, entry]) => ({ public_path, entry }));
    await client.query(`INSERT INTO internal.core_retained_static
      (project_id, source_release_id, public_path, superseded_at, origin_available_until, entry)
      SELECT $1, $2, e.public_path, NOW(), NOW() + INTERVAL '1 hour', e.entry
      FROM jsonb_to_recordset($3::jsonb) AS e(public_path text, entry jsonb)
      ON CONFLICT DO NOTHING`, [input.projectId, input.expectedBaseReleaseId, JSON.stringify(entries)]);
  }
  await client.query('DELETE FROM internal.core_retained_static WHERE origin_available_until <= NOW()');
}
