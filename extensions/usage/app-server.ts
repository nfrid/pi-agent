import { queryViaCodexAppServer as queryShared } from '../../packages/dashboard-protocol/src/usage-app-server';
import type { UsageReport } from './types';

// The daemon and the Pi extension share the same maintained app-server
// transport. Keep this compatibility entry point for extension consumers.
export async function queryViaCodexAppServer(
  signal: AbortSignal,
): Promise<UsageReport> {
  return (await queryShared(signal)) as unknown as UsageReport;
}
