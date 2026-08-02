import { searchWithExaHttp } from './exa-http';
import { callExaMcp, searchWithExaMcp } from './exa-mcp';
import type { SearchOptions, SearchResponse } from './types';
import {
  getWebSearchConfigPath,
  loadWebSearchConfig,
  normalizeApiKey,
} from './utils';

const CONFIG_PATH = getWebSearchConfigPath();

export type ExaSearchResult = SearchResponse | null;

export type ExaSearchOptions = SearchOptions;

function getApiKey(): string | null {
  return (
    normalizeApiKey(process.env.EXA_API_KEY) ??
    normalizeApiKey(loadWebSearchConfig(CONFIG_PATH).exaApiKey)
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
