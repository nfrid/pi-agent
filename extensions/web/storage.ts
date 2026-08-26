import type { CacheFile } from '../shared/cache-files';
import type { ExtractedContent } from './extract';
import type { SearchResult } from './types';

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
  store(id: string, data: StoredSearchData, cacheFile?: CacheFile): void;
  get(id: string): StoredSearchData | null;
  all(): StoredSearchData[];
  cacheFile(id: string): CacheFile | undefined;
  delete(id: string): boolean;
  clear(): void;
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

/** Create in-memory continuation state for one web extension instance. */
export function createWebResultStore(): WebResultStore {
  const results = new Map<string, StoredSearchData>();
  const files = new Map<string, CacheFile>();
  const clear = () => {
    results.clear();
    files.clear();
  };

  return {
    store(id, data, cacheFile) {
      results.set(id, data);
      if (cacheFile) files.set(id, cacheFile);
      else files.delete(id);
    },
    get: (id) => results.get(id) ?? null,
    all: () => Array.from(results.values()),
    cacheFile: (id) => files.get(id),
    delete(id) {
      files.delete(id);
      return results.delete(id);
    },
    clear,
  };
}
