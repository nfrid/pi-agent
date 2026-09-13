import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { fetchHeaders } from '../shared/provider-headers';
import {
  getWebSearchConfigPath,
  loadWebSearchConfig,
  normalizeApiKey,
} from './utils';

export const OPENAI_CONFIG_PATH = getWebSearchConfigPath();

const SEARCH_MODEL = 'gpt-5.6-luna';

export interface OpenAIAuth {
  provider: 'openai-codex' | 'openai';
  apiKey: string;
  model: string;
  headers: Record<string, string>;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const padded = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function isCodexJwt(token: string): boolean {
  const payload = decodeJwtPayload(token);
  return !!payload?.['https://api.openai.com/auth'];
}

export function extractAccountId(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  const auth = payload?.['https://api.openai.com/auth'];
  if (!auth || typeof auth !== 'object') return undefined;
  const id = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : undefined;
}

export async function resolveOpenAIAuth(
  ctx?: ExtensionContext,
): Promise<OpenAIAuth | undefined> {
  if (ctx) {
    const models = ctx.modelRegistry.getAll();
    for (const provider of ['openai-codex', 'openai'] as const) {
      const model = models.find(
        (item) => item.provider === provider && item.id === SEARCH_MODEL,
      );
      if (!model) continue;
      try {
        const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (resolved.ok && resolved.apiKey) {
          return {
            provider,
            apiKey: resolved.apiKey,
            model: SEARCH_MODEL,
            headers: fetchHeaders(resolved.headers),
          };
        }
      } catch {
        // Try the next authentication source.
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
