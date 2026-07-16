import { createHash } from 'node:crypto';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ArtifactMetadata } from '../artifacts';
import type { ExtractedContent } from './extract';
import type { SearchResult } from './types';

const CACHE_TTL_MS = 60 * 60 * 1000;
export const WEB_REFERENCE_TYPE = 'web-artifact-reference:v1';
/** Exact full-payload fallback used only when artifact persistence is unavailable. */
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

const storedResults = new Map<string, StoredSearchData>();
const storedArtifacts = new Map<string, ArtifactMetadata>();

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function storeResult(id: string, data: StoredSearchData): void {
  storedResults.set(id, data);
}

export function getResult(id: string): StoredSearchData | null {
  return storedResults.get(id) ?? null;
}

export function getAllResults(): StoredSearchData[] {
  return Array.from(storedResults.values());
}

export function getResultArtifact(id: string): ArtifactMetadata | undefined {
  return storedArtifacts.get(id);
}

export function deleteResult(id: string): boolean {
  return storedResults.delete(id);
}

export function clearResults(): void {
  storedResults.clear();
  storedArtifacts.clear();
}

function isValidStoredData(data: unknown): data is StoredSearchData {
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
    artifact.contentClass === 'json' &&
    typeof artifact.handle === 'string' &&
    typeof artifact.sha256 === 'string' &&
    typeof artifact.size === 'number'
  );
}

export function restoreFromSession(ctx: ExtensionContext): void {
  clearResults();
  const branch = ctx.sessionManager.getBranch();
  const recovery = new Map<
    string,
    { metadata: ArtifactMetadata; bytes: string }
  >();
  const purged = new Set<string>();

  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== 'artifact:v1') continue;
    const value = entry.data as Record<string, unknown> | undefined;
    if (
      (value?.kind === 'revoke' || value?.kind === 'purge') &&
      typeof value.handle === 'string'
    ) {
      purged.add(value.handle);
      recovery.delete(value.handle);
    } else if (
      value?.kind === 'recovery' &&
      typeof value.bytes === 'string' &&
      value.metadata &&
      typeof value.metadata === 'object'
    ) {
      const metadata = value.metadata as ArtifactMetadata;
      if (!purged.has(metadata.handle))
        recovery.set(metadata.handle, { metadata, bytes: value.bytes });
    }
  }

  for (const entry of branch) {
    if (entry.type !== 'custom') continue;
    if (entry.customType === 'web-search-results') {
      const data = entry.data;
      // Historical entries retain their one-hour cache semantics.
      if (isValidStoredData(data) && Date.now() - data.timestamp < CACHE_TTL_MS)
        storedResults.set(data.id, data);
      continue;
    }
    if (entry.customType === WEB_FALLBACK_TYPE) {
      // Versioned fallback entries are exact and intentionally never TTL-expire.
      if (validFallback(entry.data))
        storedResults.set(entry.data.data.id, entry.data.data);
      continue;
    }
    if (entry.customType !== WEB_REFERENCE_TYPE || !validReference(entry.data))
      continue;
    const reference = entry.data;
    const recovered = recovery.get(reference.artifact.handle);
    if (!recovered || purged.has(reference.artifact.handle)) continue;
    try {
      const bytes = Buffer.from(recovered.bytes, 'base64');
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (
        bytes.length !== reference.artifact.size ||
        hash !== reference.artifact.sha256 ||
        recovered.metadata.sha256 !== reference.artifact.sha256
      )
        continue;
      const data = JSON.parse(bytes.toString('utf8')) as unknown;
      if (
        isValidStoredData(data) &&
        data.id === reference.responseId &&
        data.type === reference.resultType
      ) {
        storedResults.set(data.id, data);
        storedArtifacts.set(data.id, reference.artifact);
      }
    } catch {
      // Ignore malformed or unavailable recovery records.
    }
  }
}
