import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { queryViaCodexAppServer } from './app-server';
import { CODEX_USAGE_URL, TIMEOUT_MS } from './constants';
import { isCodexModel } from './display';
import { hasHeader, normalizeBackendPayload } from './parse';
import type { BackendPayload, PiModel, UsageReport } from './types';

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init.signal;
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('Usage request timed out.')),
    TIMEOUT_MS,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
  }
}

async function resolvePiCodexHeaders(
  ctx: ExtensionContext,
): Promise<Record<string, string> | undefined> {
  const candidates: PiModel[] = [];
  const seen = new Set<string>();
  const add = (model: ExtensionContext['model']) => {
    if (!isCodexModel(model)) return;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(model);
  };

  add(ctx.model);
  for (const model of ctx.modelRegistry.getAvailable()) add(model);
  for (const model of ctx.modelRegistry.getAll()) add(model);

  for (const model of candidates) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) continue;
    const headers = { ...(auth.headers ?? {}) };
    if (!hasHeader(headers, 'Authorization') && auth.apiKey) {
      headers.Authorization = `Bearer ${auth.apiKey}`;
    }
    if (!hasHeader(headers, 'User-Agent')) headers['User-Agent'] = 'pi-usage';
    if (hasHeader(headers, 'Authorization')) return headers;
  }

  return undefined;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function queryViaPiAuth(
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<UsageReport> {
  const headers = await abortable(resolvePiCodexHeaders(ctx), signal);
  signal.throwIfAborted();
  if (!headers) throw new Error('No Pi Codex auth available.');

  const response = await fetchWithTimeout(CODEX_USAGE_URL, {
    headers,
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Codex usage endpoint returned ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  return normalizeBackendPayload(JSON.parse(text) as BackendPayload);
}

export async function queryUsage(
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<UsageReport> {
  try {
    return await queryViaPiAuth(ctx, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return queryViaCodexAppServer(signal);
  }
}
