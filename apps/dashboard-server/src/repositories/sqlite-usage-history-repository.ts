import type { DatabaseSync } from 'node:sqlite';
import {
  boundedUsageResetAfterSeconds,
  boundedUsageTimestamp,
  isUsageResetBoundary,
  parseUsageTimestamp,
  type UsageBurnRate,
  type UsageHistoryPoint,
  type UsageHistoryRange,
  type UsageHistoryResponse,
  type UsageHistorySeries,
} from '@pi-dashboard/protocol';

const MAX_SERIES = 64;
const MAX_POINTS_PER_SERIES = 720;
const BURN_RATE_POINTS = 2_000;
const MIN_BURN_RATE_HOURS = 10 / 60;

export type UsageHistorySample = {
  capturedAt: number;
  limitId: string;
  limitName: string;
  windowKind: 'primary' | 'secondary';
  windowLabel: string;
  windowMinutes?: number;
  usedPercent: number;
  resetsAt?: number;
};

type UsageRow = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function numberFrom(value: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const number = finiteNumber(value[key]);
    if (number !== undefined) return number;
  }
  return undefined;
}

function boundedText(value: unknown, fallback: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, max);
}

function resetFrom(
  value: Record<string, unknown>,
  capturedAt: number,
): number | undefined {
  for (const key of [
    'resetsAt',
    'resetAt',
    'reset_at',
    'resets_at',
    'resetTime',
    'reset_time',
  ]) {
    const reset = parseUsageTimestamp(value[key]);
    if (reset !== undefined) return reset;
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

function windowMinutes(value: Record<string, unknown>): number | undefined {
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
  return seconds !== undefined && seconds > 0 ? seconds / 60 : undefined;
}

function windowLabel(
  value: Record<string, unknown>,
  kind: 'primary' | 'secondary',
  minutes?: number,
): string {
  const explicit = value.windowLabel ?? value.window_label ?? value.label;
  if (typeof explicit === 'string' && explicit.trim()) {
    const normalized = explicit.trim();
    if (/^weekly$/iu.test(normalized)) return 'wk';
    if (/^5\s*hours?$/iu.test(normalized)) return '5h';
    return normalized.slice(0, 64);
  }
  if (minutes === 300) return '5h';
  if (minutes === 10_080) return 'wk';
  if (minutes !== undefined) {
    if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }
  return kind;
}

/** Projects a provider response into bounded, durable per-window samples. */
export function normalizeUsageHistorySamples(
  usage: unknown,
  capturedAt: number,
): UsageHistorySample[] {
  const root = record(usage);
  const nested = record(root?.usage);
  const source = Array.isArray(root?.snapshots)
    ? root
    : Array.isArray(nested?.snapshots)
      ? nested
      : undefined;
  if (!source || !Array.isArray(source.snapshots)) return [];
  return source.snapshots.flatMap((raw, index) => {
    const snapshot = record(raw);
    if (!snapshot) return [];
    const limitId = boundedText(
      snapshot.limitId ?? snapshot.id,
      `${index}`,
      128,
    );
    const limitName = boundedText(
      snapshot.limitName ?? snapshot.name,
      limitId,
      256,
    );
    return (['primary', 'secondary'] as const).flatMap((kind) => {
      const value = record(
        kind === 'primary'
          ? (snapshot.primary ??
              snapshot.primaryWindow ??
              snapshot.primary_window)
          : (snapshot.secondary ??
              snapshot.secondaryWindow ??
              snapshot.secondary_window),
      );
      if (!value) return [];
      const usedPercent = numberFrom(value, ['usedPercent', 'used_percent']);
      if (usedPercent === undefined) return [];
      const minutes = windowMinutes(value);
      const resetsAt = resetFrom(value, capturedAt);
      return [
        {
          capturedAt,
          limitId,
          limitName,
          windowKind: kind,
          windowLabel: windowLabel(value, kind, minutes),
          ...(minutes === undefined ? {} : { windowMinutes: minutes }),
          usedPercent: Math.max(0, Math.min(100, usedPercent)),
          ...(resetsAt === undefined ? {} : { resetsAt }),
        },
      ];
    });
  });
}

function rangeStart(range: UsageHistoryRange, now: number): number | undefined {
  if (range === '24h') return now - 24 * 60 * 60_000;
  if (range === '7d') return now - 7 * 24 * 60 * 60_000;
  if (range === '30d') return now - 30 * 24 * 60 * 60_000;
  return undefined;
}

function point(row: UsageRow): UsageHistoryPoint {
  return {
    capturedAt: Number(row.captured_at),
    usedPercent: Number(row.used_percent),
    ...(row.resets_at == null ? {} : { resetsAt: Number(row.resets_at) }),
  };
}

function burnRate(
  points: readonly UsageHistoryPoint[],
  windowMinutes: number | undefined,
): UsageBurnRate | undefined {
  if (points.length < 2) return undefined;
  const latest = points.at(-1);
  if (!latest) return undefined;
  let cycleStart = 0;
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[index - 1];
    if (current && previous && isUsageResetBoundary(previous, current))
      cycleStart = index;
  }
  const lookback = Math.min(
    (windowMinutes ?? 1_440) * 60_000,
    24 * 60 * 60_000,
  );
  const cutoff = latest.capturedAt - lookback;
  const cycle = points
    .slice(cycleStart)
    .filter((item) => item.capturedAt >= cutoff);
  const first = cycle[0];
  if (!first || cycle.length < 2) return undefined;
  const observedHours = (latest.capturedAt - first.capturedAt) / 3_600_000;
  if (observedHours < MIN_BURN_RATE_HOURS) return undefined;
  const xMean =
    cycle.reduce(
      (sum, item) => sum + (item.capturedAt - first.capturedAt) / 3_600_000,
      0,
    ) / cycle.length;
  const yMean =
    cycle.reduce((sum, item) => sum + item.usedPercent, 0) / cycle.length;
  let covariance = 0;
  let variance = 0;
  for (const item of cycle) {
    const x = (item.capturedAt - first.capturedAt) / 3_600_000 - xMean;
    covariance += x * (item.usedPercent - yMean);
    variance += x * x;
  }
  const percentPerHour = variance > 0 ? covariance / variance : 0;
  if (!Number.isFinite(percentPerHour) || percentPerHour <= 0.01)
    return undefined;
  const hoursRemaining = (100 - latest.usedPercent) / percentPerHour;
  const projectedExhaustionAt =
    hoursRemaining >= 0
      ? boundedUsageTimestamp(latest.capturedAt + hoursRemaining * 3_600_000)
      : undefined;
  return {
    percentPerHour,
    observedHours,
    ...(projectedExhaustionAt === undefined ? {} : { projectedExhaustionAt }),
    ...(latest.resetsAt === undefined || projectedExhaustionAt === undefined
      ? {}
      : { exhaustsBeforeReset: projectedExhaustionAt < latest.resetsAt }),
  };
}

export class SqliteUsageHistoryRepository {
  constructor(private readonly db: DatabaseSync) {}

  append(samples: readonly UsageHistorySample[]): void {
    if (samples.length === 0) return;
    const insert = this.db.prepare(`
      INSERT INTO usage_sample
        (captured_at,limit_id,limit_name,window_kind,window_label,window_minutes,used_percent,resets_at)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    this.db.exec('BEGIN');
    try {
      for (const sample of samples)
        insert.run(
          sample.capturedAt,
          sample.limitId,
          sample.limitName,
          sample.windowKind,
          sample.windowLabel,
          sample.windowMinutes ?? null,
          sample.usedPercent,
          sample.resetsAt ?? null,
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  read(range: UsageHistoryRange, now = Date.now()): UsageHistoryResponse {
    const since = rangeStart(range, now);
    const filter = since === undefined ? '' : 'WHERE captured_at >= ?';
    const identities = this.db
      .prepare(
        `SELECT limit_id,window_kind,MAX(captured_at) AS latest_at
         FROM usage_sample ${filter}
         GROUP BY limit_id,window_kind
         ORDER BY limit_id,window_kind
         LIMIT ${MAX_SERIES}`,
      )
      .all(...(since === undefined ? [] : [since])) as UsageRow[];
    const series = identities.flatMap((identity) => {
      const limitId = String(identity.limit_id);
      const windowKind = String(identity.window_kind) as
        | 'primary'
        | 'secondary';
      const latest = this.db
        .prepare(
          `SELECT limit_name,window_label,window_minutes
           FROM usage_sample
           WHERE limit_id=? AND window_kind=?
           ORDER BY captured_at DESC,id DESC LIMIT 1`,
        )
        .get(limitId, windowKind) as UsageRow | undefined;
      if (!latest) return [];
      const countRow = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM usage_sample
           WHERE limit_id=? AND window_kind=?${since === undefined ? '' : ' AND captured_at>=?'}`,
        )
        .get(limitId, windowKind, ...(since === undefined ? [] : [since])) as
        | UsageRow
        | undefined;
      const count = Number(countRow?.count ?? 0);
      const stride = Math.max(
        1,
        Math.ceil(count / (MAX_POINTS_PER_SERIES - 2)),
      );
      const rows = this.db
        .prepare(
          `WITH ordered AS (
             SELECT id,captured_at,used_percent,resets_at,
               ROW_NUMBER() OVER (ORDER BY captured_at,id) AS position,
               COUNT(*) OVER () AS total
             FROM usage_sample
             WHERE limit_id=? AND window_kind=?${since === undefined ? '' : ' AND captured_at>=?'}
           )
           SELECT id,captured_at,used_percent,resets_at FROM ordered
           WHERE total<=${MAX_POINTS_PER_SERIES}
             OR position=1 OR position=total OR position % ?=0
           ORDER BY captured_at,id`,
        )
        .all(
          limitId,
          windowKind,
          ...(since === undefined ? [] : [since]),
          stride,
        ) as UsageRow[];
      const recent = this.db
        .prepare(
          `SELECT captured_at,used_percent,resets_at FROM usage_sample
           WHERE limit_id=? AND window_kind=?
           ORDER BY captured_at DESC,id DESC LIMIT ${BURN_RATE_POINTS}`,
        )
        .all(limitId, windowKind)
        .reverse() as UsageRow[];
      const windowMinutes =
        latest.window_minutes == null
          ? undefined
          : Number(latest.window_minutes);
      const rate = burnRate(recent.map(point), windowMinutes);
      const item: UsageHistorySeries = {
        limitId,
        limitName: String(latest.limit_name),
        windowKind,
        windowLabel: String(latest.window_label),
        ...(windowMinutes === undefined ? {} : { windowMinutes }),
        points: rows.map(point),
        ...(rate === undefined ? {} : { burnRate: rate }),
      };
      return [item];
    });
    return { range, generatedAt: now, series };
  }
}
