import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { type ArtifactMetadata, artifactConsumer } from '../artifacts';
import type { ExtractedContent } from './extract';
import type { SearchResult } from './types';

export const WEB_REFERENCE_TYPE = 'web-artifact-reference:v1';
/** Legacy inline fallback kept only so older sessions can still restore. */
export const WEB_FALLBACK_TYPE = 'web-search-results:v1';

export interface WebFallbackEntry {
  version: 1;
  data: StoredSearchData;
}

export interface WebArtifactReference {
  version: 1;
  responseId: string;
  resultType: 'search' | 'fetch';
  artifact: ArtifactMetadata;
}

export interface QueryResultData {
  query: string;
  answer: string;
  results: SearchResult[];
  error: string | null;
  provider?: string;
  content?: ExtractedContent[];
}

export interface StoredSearchData {
  id: string;
  type: 'search' | 'fetch';
  timestamp: number;
  queries?: QueryResultData[];
  urls?: ExtractedContent[];
  /** Exact aggregate/summary representation initially rendered by the tool. */
  summary?: string;
}

export interface WebResultStore {
  store(id: string, data: StoredSearchData, artifact?: ArtifactMetadata): void;
  get(id: string): StoredSearchData | null;
  all(): StoredSearchData[];
  artifact(id: string): ArtifactMetadata | undefined;
  delete(id: string): boolean;
  clear(): void;
  restore(ctx: ExtensionContext): void;
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function isValidStoredData(data: unknown): data is StoredSearchData {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (typeof d.id !== 'string' || !d.id) return false;
  if (d.type !== 'search' && d.type !== 'fetch') return false;
  if (typeof d.timestamp !== 'number') return false;
  if (d.summary !== undefined && typeof d.summary !== 'string') return false;
  if (d.type === 'search' && !Array.isArray(d.queries)) return false;
  if (d.type === 'fetch' && !Array.isArray(d.urls)) return false;
  return true;
}

function validFallback(data: unknown): data is WebFallbackEntry {
  if (!data || typeof data !== 'object') return false;
  const value = data as Record<string, unknown>;
  return value.version === 1 && isValidStoredData(value.data);
}

function validReference(data: unknown): data is WebArtifactReference {
  if (!data || typeof data !== 'object') return false;
  const value = data as Record<string, unknown>;
  const artifact = value.artifact as Record<string, unknown> | undefined;
  return (
    value.version === 1 &&
    typeof value.responseId === 'string' &&
    (value.resultType === 'search' || value.resultType === 'fetch') &&
    artifact?.producer === 'web' &&
    artifact.contentClass === 'json'
  );
}

/** Create branch-local continuation state for exactly one web extension instance. */
export function createWebResultStore(): WebResultStore {
  const results = new Map<string, StoredSearchData>();
  const artifacts = new Map<string, ArtifactMetadata>();
  const clear = () => {
    results.clear();
    artifacts.clear();
  };

  return {
    store(id, data, artifact) {
      results.set(id, data);
      if (artifact) artifacts.set(id, artifact);
      else artifacts.delete(id);
    },
    get: (id) => results.get(id) ?? null,
    all: () => Array.from(results.values()),
    artifact: (id) => artifacts.get(id),
    delete(id) {
      artifacts.delete(id);
      return results.delete(id);
    },
    clear,
    restore(ctx) {
      clear();
      const branch = ctx.sessionManager.getBranch();
      for (const entry of branch) {
        if (entry.type !== 'custom') continue;
        if (entry.customType === WEB_FALLBACK_TYPE) {
          if (validFallback(entry.data))
            results.set(entry.data.data.id, entry.data.data);
          continue;
        }
        if (
          entry.customType !== WEB_REFERENCE_TYPE ||
          !validReference(entry.data)
        )
          continue;
        const reference = entry.data;
        const recovered = artifactConsumer.recoverFromEntries(
          branch,
          reference.artifact,
        );
        if (!recovered) continue;
        try {
          const data = JSON.parse(recovered.bytes.toString('utf8')) as unknown;
          if (
            isValidStoredData(data) &&
            data.id === reference.responseId &&
            data.type === reference.resultType
          ) {
            results.set(data.id, data);
            artifacts.set(data.id, recovered.metadata);
          }
        } catch {
          // Ignore malformed or unavailable artifact payloads.
        }
      }
    },
  };
}
