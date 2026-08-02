import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { abortableDelay, throwIfAborted } from '../shared/runtime/async';

export { abortableDelay, throwIfAborted };

export function getWebSearchConfigDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, 'pi');
  }
  return join(homedir(), '.pi');
}

export function getWebSearchConfigPath(): string {
  return join(getWebSearchConfigDir(), 'web-search.json');
}

export interface WebSearchConfig {
  exaApiKey?: unknown;
  openaiApiKey?: unknown;
  ssrf?: { allowRanges?: unknown };
}

export function loadWebSearchConfig(
  path = getWebSearchConfigPath(),
  options: { ignoreMalformed?: boolean } = {},
): WebSearchConfig {
  if (!existsSync(path)) return {};

  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw) as WebSearchConfig;
  } catch (error) {
    if (options.ignoreMalformed && error instanceof SyntaxError) return {};
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${path}: ${message}`);
  }
}

export function normalizeApiKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** Fetch with a small, bounded retry budget for transient transport/server failures. */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: { retries?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<Response> {
  const retries = Math.min(5, Math.max(0, options.retries ?? 2));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 250);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 5_000);
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(init.signal ?? undefined);
    try {
      const response = await fetch(input, init);
      if (!TRANSIENT_STATUSES.has(response.status) || attempt >= retries)
        return response;
      const retryAfter = retryAfterMs(response);
      await response.body?.cancel('Retrying transient response');
      const delay = Math.min(
        maxDelayMs,
        retryAfter ?? baseDelayMs * 2 ** attempt,
      );
      await abortableDelay(delay, init.signal ?? undefined);
    } catch (error) {
      throwIfAborted(init.signal ?? undefined);
      if (attempt >= retries) throw error;
      await abortableDelay(
        Math.min(maxDelayMs, baseDelayMs * 2 ** attempt),
        init.signal ?? undefined,
      );
    }
  }
}

export async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('Response exceeded size limit');
        throw new Error(`Response too large (limit: ${maxBytes} bytes)`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}
