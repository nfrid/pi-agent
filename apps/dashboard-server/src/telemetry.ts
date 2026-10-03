import { VERSION } from '@earendil-works/pi-coding-agent';
import {
  BROWSER_TELEMETRY_CODES,
  type BrowserTelemetryInput,
  TELEMETRY_MAX_NOTE_LENGTH,
  type TelemetryEvent,
  type TelemetryOverview,
  TelemetryStore,
  telemetryVersion,
} from '@pi-agent/telemetry';

/** Strict browser input: do not accept exception objects, URLs or free metadata. */
export function parseBrowserTelemetryInput(
  value: unknown,
): BrowserTelemetryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid telemetry report.');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !['code', 'version', 'note', 'sessionId'].includes(key),
    ) ||
    typeof input.code !== 'string' ||
    !(
      input.code === 'manual-report' ||
      (BROWSER_TELEMETRY_CODES as readonly string[]).includes(input.code)
    ) ||
    typeof input.version !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(input.version) ||
    (input.sessionId !== undefined &&
      (typeof input.sessionId !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(input.sessionId))) ||
    (input.code === 'manual-report'
      ? typeof input.note !== 'string' ||
        !input.note.trim() ||
        input.note.length > TELEMETRY_MAX_NOTE_LENGTH
      : input.note !== undefined)
  )
    throw new Error('Invalid telemetry report.');
  return input as unknown as BrowserTelemetryInput;
}

export class DashboardTelemetry {
  private readonly store: TelemetryStore;
  private windowStart = 0;
  private reports = 0;
  constructor(
    directory: string,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new TelemetryStore(directory, now);
  }
  record(event: Omit<TelemetryEvent, 'source' | 'version'>): void {
    this.store.record({
      ...event,
      source: 'dashboard-server',
      version: telemetryVersion(VERSION),
    });
  }
  overview(): TelemetryOverview {
    return this.store.overview();
  }
  report(input: BrowserTelemetryInput): { accepted: boolean } {
    // A shared ceiling bounds authenticated floods without storing browser IDs.
    const now = this.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.reports = 0;
    }
    if (this.reports >= 120) return { accepted: false };
    this.reports++;
    const connection = [
      'connection-error',
      'authentication',
      'protocol-mismatch',
      'connected',
    ].includes(input.code);
    return {
      accepted: this.store.record({
        source: 'dashboard-browser',
        operation:
          input.code === 'manual-report'
            ? 'manual-report'
            : connection
              ? 'connection'
              : 'browser',
        code: input.code,
        version: input.version,
        outcome:
          input.code === 'manual-report'
            ? 'quirk'
            : input.code === 'connected'
              ? 'success'
              : input.code === 'authentication' ||
                  input.code === 'protocol-mismatch'
                ? 'expected'
                : 'failure',
        ...(input.note ? { note: input.note } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      }),
    };
  }
  close(): void {
    this.store.close();
  }
}
