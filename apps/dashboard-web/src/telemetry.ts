import type {
  BrowserTelemetryCode,
  BrowserTelemetryInput,
} from '@pi-agent/telemetry/contracts';
import { dashboardHttpClient } from '@pi-dashboard/client';

declare const __DASHBOARD_BUILD_ID__: string;
export const telemetryBuildVersion =
  typeof __DASHBOARD_BUILD_ID__ === 'string'
    ? __DASHBOARD_BUILD_ID__
    : 'development';
const pending: BrowserTelemetryInput[] = [];
let sending = false;
let lastSessionId: string | undefined;

function sessionId(): string | undefined {
  const match = window.location.pathname.match(
    /^\/sessions\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,95})(?:\/|$)/,
  );
  if (match) lastSessionId = match[1];
  return lastSessionId;
}

/** The queue lives only in memory, is bounded, and retries on connection/online events. */
export async function flushBrowserTelemetry(): Promise<void> {
  if (sending || pending.length === 0 || !navigator.onLine) return;
  sending = true;
  let current: BrowserTelemetryInput | undefined;
  try {
    const client = await dashboardHttpClient.getTrpcClient();
    while (pending.length > 0) {
      current = pending.shift();
      if (!current) break;
      await client.telemetryReport.mutate(current);
      current = undefined;
    }
  } catch {
    if (current) {
      pending.unshift(current);
      if (pending.length > 20) pending.pop();
    }
    // Never report a reporting failure, which would recurse during an outage.
  } finally {
    sending = false;
  }
}

export function reportBrowserTelemetry(code: BrowserTelemetryCode): void {
  if (pending.length >= 20) pending.shift();
  pending.push({
    code,
    version: telemetryBuildVersion,
    sessionId: sessionId(),
  });
  void flushBrowserTelemetry();
}

export async function reportDashboardQuirk(note: string): Promise<boolean> {
  const client = await dashboardHttpClient.getTrpcClient();
  const result = await client.telemetryReport.mutate({
    code: 'manual-report',
    version: telemetryBuildVersion,
    note,
    sessionId: sessionId(),
  });
  return result.accepted;
}

export function installBrowserTelemetry(): () => void {
  const error = () => reportBrowserTelemetry('uncaught-error');
  const rejection = () => reportBrowserTelemetry('unhandled-rejection');
  const online = () => {
    void flushBrowserTelemetry();
  };
  window.addEventListener('error', error);
  window.addEventListener('unhandledrejection', rejection);
  window.addEventListener('online', online);
  return () => {
    window.removeEventListener('error', error);
    window.removeEventListener('unhandledrejection', rejection);
    window.removeEventListener('online', online);
  };
}
