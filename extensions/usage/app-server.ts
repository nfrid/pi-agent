import { queryViaCodexAppServer as queryShared } from '@pi-dashboard/codex-usage';
import type { UsageReport } from '@pi-dashboard/protocol';

// The daemon and the Pi extension share one Node-only app-server transport.
// Keep this compatibility entry point for extension consumers.
export async function queryViaCodexAppServer(
  signal: AbortSignal,
): Promise<UsageReport> {
  return queryShared(signal);
}
