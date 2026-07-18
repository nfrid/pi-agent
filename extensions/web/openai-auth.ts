import { existsSync, readFileSync } from 'node:fs';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getWebSearchConfigPath } from './utils';

export const OPENAI_CONFIG_PATH = getWebSearchConfigPath();

const AUTH_MODEL_CANDIDATES = [
  {
    provider: 'openai-codex',
    models: [
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'gpt-5.2',
      'gpt-5.2-codex',
    ],
  },
  {
    provider: 'openai',
    models: ['gpt-5.4', 'gpt-5.2', 'gpt-4.1-mini', 'gpt-4o'],
  },
] as const;

interface WebSearchConfig {
  openaiApiKey?: unknown;
}

export interface OpenAIAuth {
  provider: 'openai-codex' | 'openai';
  apiKey: string;
  model: string;
  headers: Record<string, string>;
}

function loadConfig(): WebSearchConfig {
  if (!existsSync(OPENAI_CONFIG_PATH)) return {};

  const raw = readFileSync(OPENAI_CONFIG_PATH, 'utf-8');
  try {
    return JSON.parse(raw) as WebSearchConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${OPENAI_CONFIG_PATH}: ${message}`);
  }
}

function normalizeApiKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
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
    for (const candidate of AUTH_MODEL_CANDIDATES) {
      for (const modelId of candidate.models) {
        const model = models.find(
          (item) => item.provider === candidate.provider && item.id === modelId,
        );
        if (!model) continue;
        try {
          const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
          if (resolved.ok && resolved.apiKey) {
            return {
              provider: candidate.provider,
              apiKey: resolved.apiKey,
              model: modelId,
              headers: resolved.headers ?? {},
            };
          }
        } catch {
          // Try the next authenticated model.
        }
      }
    }
  }

  const apiKey =
    normalizeApiKey(process.env.OPENAI_API_KEY) ??
    normalizeApiKey(loadConfig().openaiApiKey);
  return apiKey
    ? { provider: 'openai', apiKey, model: 'gpt-5.4', headers: {} }
    : undefined;
}

export async function isOpenAISearchAvailable(
  ctx?: ExtensionContext,
): Promise<boolean> {
  return !!(await resolveOpenAIAuth(ctx));
}
