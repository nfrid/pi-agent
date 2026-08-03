import { queryViaCodexAppServer } from '@pi-dashboard/codex-usage';

export interface UsageProvider {
  get(signal?: AbortSignal): Promise<unknown>;
}

/**
 * The daemon deliberately reuses Pi's maintained app-server backend instead of
 * maintaining a second unauthenticated HTTP implementation. It inherits the
 * extension's auth/session protocol and normalization.
 */
export class CodexUsageProvider implements UsageProvider {
  async get(signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await queryViaCodexAppServer(controller.signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
