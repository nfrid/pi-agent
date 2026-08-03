import { queryViaCodexAppServer as queryShared } from '../../packages/codex-usage/src/index';
import type { UsageReport } from './types';

// The daemon and the Pi extension share one Node-only app-server transport.
// Keep this compatibility entry point for extension consumers.
export async function queryViaCodexAppServer(
  signal: AbortSignal,
): Promise<UsageReport> {
  return (await queryShared(signal)) as unknown as UsageReport;
}
