import { isDirectStaticManifestEntry, type StaticManifestFileEntry } from '@run402/release';

export const STATIC_ORIGIN_RETENTION_SECONDS = 3600;
export interface RetainedStaticEntry {
  source_release_id: string;
  origin_available_until: string;
  entry: StaticManifestFileEntry;
}

/** Public identity is the authority; a backing asset path alone never publishes it. */
export function isRetainablePublicEntry(path: string, entry: StaticManifestFileEntry): boolean {
  return path.startsWith('/') && !path.startsWith('/_run402/') &&
    isDirectStaticManifestEntry(entry) && entry.cache_class !== 'html' &&
    !/\.(?:html?|xhtml)(?:\/|$)/i.test(path) &&
    !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(entry.content_type);
}
