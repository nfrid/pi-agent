import { type Static, Type } from 'typebox';
import {
  boundedUsageResetAfterSeconds,
  boundedUsageTimestamp,
  MAX_USAGE_TIMESTAMP,
  parseUsageTimestamp,
} from './usage-history.js';

const MAX_USAGE_SNAPSHOTS = 64;
const MAX_USAGE_LIMIT_ID = 128;
const MAX_USAGE_LIMIT_NAME = 256;
const MAX_USAGE_WINDOW_LABEL = 64;

export const UsageWindowSchema = Type.Object(
  {
    usedPercent: Type.Number({ minimum: 0, maximum: 100 }),
    windowMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    windowLabel: Type.Optional(
      Type.String({ minLength: 1, maxLength: MAX_USAGE_WINDOW_LABEL }),
    ),
    /** Absolute Unix timestamp in milliseconds. */
    resetsAt: Type.Optional(
      Type.Number({ minimum: 0, maximum: MAX_USAGE_TIMESTAMP }),
    ),
  },
  { additionalProperties: false },
);
export type UsageWindow = Static<typeof UsageWindowSchema>;

export const UsageSnapshotSchema = Type.Object(
  {
    limitId: Type.String({ minLength: 1, maxLength: MAX_USAGE_LIMIT_ID }),
    limitName: Type.Optional(
      Type.String({ minLength: 1, maxLength: MAX_USAGE_LIMIT_NAME }),
    ),
    primary: Type.Optional(UsageWindowSchema),
    secondary: Type.Optional(UsageWindowSchema),
  },
  { additionalProperties: false },
);
export type UsageSnapshot = Static<typeof UsageSnapshotSchema>;

export const UsageReportSchema = Type.Object(
  {
    capturedAt: Type.Number({ minimum: 0, maximum: MAX_USAGE_TIMESTAMP }),
    provider: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    snapshots: Type.Array(UsageSnapshotSchema, {
      maxItems: MAX_USAGE_SNAPSHOTS,
    }),
  },
  { additionalProperties: false },
);
export type UsageReport = Static<typeof UsageReportSchema>;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function numberFrom(value: RecordValue, keys: readonly string[]) {
  for (const key of keys) {
    const result = number(value[key]);
    if (result !== undefined) return result;
  }
  return undefined;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value.trim().slice(0, max);
  return result || undefined;
}

function boundedText(value: unknown, fallback: string, max: number): string {
  return text(value, max) ?? (fallback.slice(0, max) || 'unknown');
}

function capturedTimestamp(value: unknown): number | undefined {
  const result = number(value);
  return result === undefined ? undefined : boundedUsageTimestamp(result);
}

function windowMinutes(
  value: RecordValue,
  roundBackendSeconds: boolean,
): number | undefined {
  const minutes = numberFrom(value, [
    'windowMinutes',
    'windowDurationMins',
    'window_minutes',
    'window_duration_mins',
  ]);
  if (minutes !== undefined && minutes > 0) return minutes;
  const seconds = numberFrom(value, [
    'windowSeconds',
    'window_seconds',
    'limitWindowSeconds',
    'limit_window_seconds',
  ]);
  return seconds !== undefined && seconds > 0
    ? roundBackendSeconds
      ? Math.ceil(seconds / 60)
      : seconds / 60
    : undefined;
}

function windowLabel(
  value: RecordValue,
  minutes: number | undefined,
): string | undefined {
  const explicit = text(
    value.windowLabel ?? value.window_label ?? value.label,
    MAX_USAGE_WINDOW_LABEL,
  );
  if (explicit) {
    if (/^weekly$/iu.test(explicit)) return 'wk';
    if (/^5\s*hours?$/iu.test(explicit)) return '5h';
    return explicit;
  }
  if (minutes === 300) return '5h';
  if (minutes === 10_080) return 'wk';
  if (minutes !== undefined && minutes % 10_080 !== 0) {
    if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }
  return undefined;
}

function resetAt(value: RecordValue, capturedAt: number): number | undefined {
  for (const key of [
    'resetsAt',
    'resetAt',
    'reset_at',
    'resets_at',
    'resetTime',
    'reset_time',
  ]) {
    const result = parseUsageTimestamp(value[key]);
    if (result !== undefined) return result;
  }
  const after = boundedUsageResetAfterSeconds(
    numberFrom(value, [
      'resetAfterSeconds',
      'reset_after_seconds',
      'resetInSeconds',
      'reset_in_seconds',
    ]),
  );
  return after === undefined
    ? undefined
    : boundedUsageTimestamp(capturedAt + after * 1_000);
}

function normalizeWindow(
  value: unknown,
  capturedAt: number,
  roundBackendSeconds: boolean,
): UsageWindow | undefined {
  const source = record(value);
  if (!source) return undefined;
  const usedPercent = numberFrom(source, ['usedPercent', 'used_percent']);
  if (usedPercent === undefined) return undefined;
  const minutes = windowMinutes(source, roundBackendSeconds);
  const label = windowLabel(source, minutes);
  const resetsAt = resetAt(source, capturedAt);
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    ...(minutes === undefined ? {} : { windowMinutes: minutes }),
    ...(label === undefined ? {} : { windowLabel: label }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function hasWindow(value: RecordValue): boolean {
  return [
    'primary',
    'secondary',
    'primaryWindow',
    'secondaryWindow',
    'primary_window',
    'secondary_window',
  ].some((key) => key in value);
}

function normalizeSnapshot(
  value: unknown,
  fallbackId: string,
  capturedAt: number,
  roundBackendSeconds: boolean,
): UsageSnapshot | undefined {
  const source = record(value);
  if (!source) return undefined;
  const primary = normalizeWindow(
    source.primary ?? source.primaryWindow ?? source.primary_window,
    capturedAt,
    roundBackendSeconds,
  );
  const secondary = normalizeWindow(
    source.secondary ?? source.secondaryWindow ?? source.secondary_window,
    capturedAt,
    roundBackendSeconds,
  );
  if (!primary && !secondary) return undefined;
  const limitId = boundedText(
    source.limitId ?? source.id,
    fallbackId,
    MAX_USAGE_LIMIT_ID,
  );
  const limitName = text(source.limitName ?? source.name, MAX_USAGE_LIMIT_NAME);
  return {
    limitId,
    ...(limitName === undefined ? {} : { limitName }),
    ...(primary === undefined ? {} : { primary }),
    ...(secondary === undefined ? {} : { secondary }),
  };
}

function mergeSnapshot(
  existing: UsageSnapshot | undefined,
  incoming: UsageSnapshot,
): UsageSnapshot {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    limitName: incoming.limitName ?? existing.limitName,
    primary: incoming.primary ?? existing.primary,
    secondary: incoming.secondary ?? existing.secondary,
  };
}

/**
 * Converts supported provider responses into one bounded dashboard usage
 * contract. Window reset timestamps are always Unix milliseconds; numeric
 * timestamps use the existing seconds/milliseconds magnitude heuristic so
 * legacy reports with a capturedAt field remain supported.
 */
export function normalizeUsage(
  value: unknown,
  fallbackCapturedAt = Date.now(),
): UsageReport {
  const root = record(value);
  const nested = record(root?.usage);
  const capturedAt =
    capturedTimestamp(root?.capturedAt) ??
    capturedTimestamp(nested?.capturedAt) ??
    capturedTimestamp(fallbackCapturedAt) ??
    Date.now();
  const provider = text(root?.provider ?? nested?.provider, 128);
  const snapshots = new Map<string, UsageSnapshot>();
  const add = (
    value: unknown,
    fallbackId: string,
    fallbackName?: string,
    roundBackendSeconds = false,
  ) => {
    const normalized = normalizeSnapshot(
      value,
      fallbackId,
      capturedAt,
      roundBackendSeconds,
    );
    if (!normalized) return;
    const snapshot =
      normalized.limitName === undefined && fallbackName !== undefined
        ? { ...normalized, limitName: fallbackName }
        : normalized;
    snapshots.set(
      snapshot.limitId,
      mergeSnapshot(snapshots.get(snapshot.limitId), snapshot),
    );
  };

  const snapshotValues = Array.isArray(root?.snapshots)
    ? root.snapshots
    : Array.isArray(nested?.snapshots)
      ? nested.snapshots
      : undefined;
  if (snapshotValues) {
    for (const [index, value] of snapshotValues.entries())
      add(value, String(index));
  } else {
    const backend = root?.rate_limit;
    if (backend !== undefined) add(backend, 'codex', undefined, true);
    const additional = root?.additional_rate_limits;
    if (Array.isArray(additional)) {
      for (const value of additional) {
        const item = record(value);
        if (!item) continue;
        const id =
          text(item.metered_feature, MAX_USAGE_LIMIT_ID) ??
          text(item.limit_name, MAX_USAGE_LIMIT_ID) ??
          'codex';
        add(
          item.rate_limit,
          id,
          text(item.limit_name, MAX_USAGE_LIMIT_NAME),
          true,
        );
      }
    }

    const rateLimits = root?.rateLimits ?? root?.rate_limits;
    const rateLimitRecord = record(rateLimits);
    if (rateLimitRecord) {
      if (hasWindow(rateLimitRecord)) add(rateLimitRecord, 'codex');
      else
        for (const [limitId, value] of Object.entries(rateLimitRecord))
          add(value, limitId);
    }
    const byId = record(root?.rateLimitsByLimitId);
    if (byId) {
      for (const [limitId, value] of Object.entries(byId)) add(value, limitId);
    }
  }

  if (
    (!snapshotValues && snapshots.size === 0) ||
    (snapshotValues !== undefined &&
      snapshotValues.length > 0 &&
      snapshots.size === 0)
  )
    throw new Error('Usage response returned no rate-limit windows.');
  return {
    capturedAt,
    ...(provider === undefined ? {} : { provider }),
    snapshots: [...snapshots.values()].slice(0, MAX_USAGE_SNAPSHOTS),
  };
}
