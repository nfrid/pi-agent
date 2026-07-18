import { existsSync, readFileSync } from 'node:fs';
import { searchWithExaHttp } from './exa-http';
import { callExaMcp, searchWithExaMcp } from './exa-mcp';
import type { SearchOptions, SearchResponse } from './types';
import { getWebSearchConfigPath } from './utils';

const CONFIG_PATH = getWebSearchConfigPath();

interface WebSearchConfig {
  exaApiKey?: unknown;
}

export type ExaSearchResult = SearchResponse | null;

export type ExaSearchOptions = SearchOptions;

function loadConfig(): WebSearchConfig {
  if (!existsSync(CONFIG_PATH)) return {};

  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  try {
    return JSON.parse(raw) as WebSearchConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
  }
}

function normalizeApiKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function getApiKey(): string | null {
  return (
    normalizeApiKey(process.env.EXA_API_KEY) ??
    normalizeApiKey(loadConfig().exaApiKey)
  );
}

export { callExaMcp };

export function isExaAvailable(): boolean {
  return true;
}

export function hasExaApiKey(): boolean {
  return !!getApiKey();
}

export async function searchWithExa(
  query: string,
  options: ExaSearchOptions = {},
): Promise<ExaSearchResult> {
  const apiKey = getApiKey();
  return apiKey
    ? searchWithExaHttp(apiKey, query, options)
    : searchWithExaMcp(query, options);
}
