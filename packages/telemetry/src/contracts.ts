export const TELEMETRY_RETENTION_DAYS = 30;
export const TELEMETRY_MAX_EVENTS = 10_000;
export const TELEMETRY_MAX_NOTE_LENGTH = 1_000;

export type TelemetrySource =
  | 'harness'
  | 'dashboard-server'
  | 'dashboard-browser';
export type TelemetryOutcome = 'success' | 'failure' | 'expected' | 'quirk';

/** Automatic records contain codes, never exception text, arguments or output. */
export interface TelemetryEvent {
  source: TelemetrySource;
  operation: string;
  code: string;
  outcome: TelemetryOutcome;
  version: string;
  durationMs?: number;
  sessionId?: string;
  attemptId?: string;
  errorName?: string;
  /** Only accepted for an explicit quirk report. */
  note?: string;
}

export type TelemetryContextEvent = Pick<
  TelemetryEvent,
  'source' | 'operation' | 'code' | 'outcome' | 'version'
> & {
  id: number;
  timestamp: number;
};
export interface TelemetrySample extends TelemetryEvent {
  id: number;
  timestamp: number;
  context?: TelemetryContextEvent[];
}

export interface TelemetryIssue {
  source: TelemetrySource;
  operation: string;
  code: string;
  outcome: Exclude<TelemetryOutcome, 'success'>;
  count: number;
  /** Retained automatic outcomes for this source and operation. */
  attempts: number;
  failures: number;
  firstSeen: number;
  lastSeen: number;
  samples: TelemetrySample[];
}

export interface TelemetryOverview {
  available: boolean;
  retentionDays: number;
  maxEvents: number;
  /** Number of stored SQLite rows, bounded by maxEvents. */
  eventCount: number;
  /** Total represented observations, including aggregated occurrences. */
  observationCount: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  issues: TelemetryIssue[];
}

export const BROWSER_TELEMETRY_CODES = [
  'uncaught-error',
  'unhandled-rejection',
  'resize-observer-loop',
  'render-error',
  'connection-error',
  'authentication',
  'protocol-mismatch',
  'connected',
] as const;
export type BrowserTelemetryCode = (typeof BROWSER_TELEMETRY_CODES)[number];

export const SAFE_TELEMETRY_ERROR_NAMES = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
] as const;
export type SafeTelemetryErrorName =
  (typeof SAFE_TELEMETRY_ERROR_NAMES)[number];

export function safeTelemetryErrorName(error: unknown): SafeTelemetryErrorName {
  try {
    const name = error instanceof Error ? error.name : '';
    return (SAFE_TELEMETRY_ERROR_NAMES as readonly string[]).includes(name)
      ? (name as SafeTelemetryErrorName)
      : 'Error';
  } catch {
    return 'Error';
  }
}

export function isSafeTelemetryErrorName(
  value: unknown,
): value is SafeTelemetryErrorName {
  return (
    typeof value === 'string' &&
    (SAFE_TELEMETRY_ERROR_NAMES as readonly string[]).includes(value)
  );
}

export interface BrowserTelemetryInput {
  code: BrowserTelemetryCode | 'manual-report';
  version: string;
  note?: string;
  sessionId?: string;
  errorName?: SafeTelemetryErrorName;
}

/** Free-text reports are deliberate; redaction is not a general secret detector. */
export function redactTelemetryNote(note: string): string {
  const redacted = note
    .slice(0, TELEMETRY_MAX_NOTE_LENGTH)
    .replace(
      /(?:Bearer\s+|\b(?:sk|ghp|github_pat|xox[baprs])[-_])[A-Za-z0-9_.\-/+=]+/gi,
      '[redacted]',
    )
    .replace(
      /\b(?:token|api[-_]?key|password|secret|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      '[redacted]',
    )
    .replace(/https?:\/\/[^\s<>]+/gi, '[url]')
    .replace(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s"'<>]+/g, '[path]')
    .replace(/\p{Cc}/gu, ' ')
    .trim();
  const encoder = new TextEncoder();
  let result = '';
  let bytes = 0;
  for (const character of redacted) {
    const size = encoder.encode(character).length;
    if (bytes + size > TELEMETRY_MAX_NOTE_LENGTH) break;
    bytes += size;
    result += character;
  }
  return result;
}
