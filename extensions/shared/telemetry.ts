import { VERSION } from '@earendil-works/pi-coding-agent';
import {
  recordTelemetry,
  safeTelemetryErrorName,
  type TelemetryEvent,
  telemetryVersion,
} from '@pi-agent/telemetry';

/** Existing test suites must not write into the user's local telemetry store. */
export function recordHarnessTelemetry(
  event: Omit<TelemetryEvent, 'source' | 'version'>,
): boolean {
  if (process.env.NODE_ENV === 'test' && !process.env.PI_TELEMETRY_DIR)
    return false;
  return recordTelemetry({
    ...event,
    source: 'harness',
    version: telemetryVersion(VERSION),
  });
}

export function recordHarnessFailure(
  operation: string,
  code: string,
  error: unknown,
  sessionId?: string,
): void {
  recordHarnessTelemetry({
    operation,
    code,
    outcome: 'failure',
    errorName: safeTelemetryErrorName(error),
    ...(sessionId ? { sessionId } : {}),
  });
}
