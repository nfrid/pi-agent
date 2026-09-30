import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { fetchHeaders } from '../shared/provider-headers';
import {
  getWebSearchConfigPath,
  loadWebSearchConfig,
  normalizeApiKey,
} from './utils';

export const OPENAI_CONFIG_PATH = getWebSearchConfigPath();

const SEARCH_MODEL = 'gpt-6-luna';

export interface OpenAIAuth {
  provider: 'openai';
  apiKey: string;
  model: string;
  headers: Record<string, string>;
}

export async function resolveOpenAIAuth(
  ctx?: ExtensionContext,
): Promise<OpenAIAuth | undefined> {
  if (ctx) {
    const model = ctx.modelRegistry
      .getAll()
      .find((item) => item.provider === 'openai' && item.id === SEARCH_MODEL);
    if (model) {
      try {
        const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (resolved.ok && resolved.apiKey) {
          return {
            provider: 'openai',
            apiKey: resolved.apiKey,
            model: SEARCH_MODEL,
            headers: fetchHeaders(resolved.headers),
          };
        }
      } catch {
        // Fall back to an explicitly configured API key.
      }
    }
  }

  const apiKey =
    normalizeApiKey(process.env.OPENAI_API_KEY) ??
    normalizeApiKey(loadWebSearchConfig(OPENAI_CONFIG_PATH).openaiApiKey);
  return apiKey
    ? { provider: 'openai', apiKey, model: SEARCH_MODEL, headers: {} }
    : undefined;
}

export async function isOpenAISearchAvailable(
  ctx?: ExtensionContext,
): Promise<boolean> {
  return !!(await resolveOpenAIAuth(ctx));
}
