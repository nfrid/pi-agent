import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { queryViaCodexAppServer } from './app-server';
import { queryViaPiAuth } from './pi-auth';
import type { UsageReport } from './types';

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
