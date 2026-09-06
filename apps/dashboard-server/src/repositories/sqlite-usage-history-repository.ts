import type { DatabaseSync } from 'node:sqlite';
import {
  boundedUsageTimestamp,
  isUsageResetBoundary,
  type UsageBurnRate,
  type UsageHistoryRange,
  type UsageHistoryResponse,
  type UsageHistorySeries,
  type UsageReport,
  usageHistoryPeriod,
} from '@pi-dashboard/protocol';

const MAX_SERIES = 64;
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

export type UsageLimitHistoryResponse = Omit<UsageHistoryResponse, 'spend'>;

type UsageRow = Record<string, unknown>;

function historyWindowLabel(
  minutes: number | undefined,
  kind: UsageHistorySample['windowKind'],
): string {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0)
    return kind;
  if (minutes === 300) return '5h';
  if (minutes === 10_080) return 'wk';
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Projects canonical usage into bounded, durable per-window samples. */
export function normalizeUsageHistorySamples(
  usage: UsageReport,
  capturedAt: number,
): UsageHistorySample[] {
  return usage.snapshots.flatMap((snapshot) =>
    (['primary', 'secondary'] as const).flatMap((kind) => {
      const window = snapshot[kind];
      if (!window) return [];
      return [
        {
          capturedAt,
          limitId: snapshot.limitId,
          limitName: snapshot.limitName ?? snapshot.limitId,
          windowKind: kind,
          windowLabel:
            window.windowLabel ??
            historyWindowLabel(window.windowMinutes, kind),
          ...(window.windowMinutes === undefined
            ? {}
            : { windowMinutes: window.windowMinutes }),
          usedPercent: window.usedPercent,
          ...(window.resetsAt === undefined
            ? {}
            : { resetsAt: window.resetsAt }),
        },
      ];
    }),
  );
}

function rawPoint(row: UsageRow) {
  return {
    capturedAt: Number(row.captured_at),
    usedPercent: Number(row.used_percent),
    ...(row.resets_at == null ? {} : { resetsAt: Number(row.resets_at) }),
  };
}

function burnRate(
  points: ReturnType<typeof rawPoint>[],
  windowMinutes: number | undefined,
): UsageBurnRate | undefined {
  const latest = points.at(-1);
  if (!latest || points.length < 2) return undefined;
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
    .filter((point) => point.capturedAt >= cutoff);
  const first = cycle[0];
  if (!first || cycle.length < 2) return undefined;
  const observedHours = (latest.capturedAt - first.capturedAt) / 3_600_000;
  if (observedHours < MIN_BURN_RATE_HOURS) return undefined;
  const xMean =
    cycle.reduce(
      (sum, point) => sum + (point.capturedAt - first.capturedAt) / 3_600_000,
      0,
    ) / cycle.length;
  const yMean =
    cycle.reduce((sum, point) => sum + point.usedPercent, 0) / cycle.length;
  let covariance = 0;
  let variance = 0;
  for (const point of cycle) {
    const x = (point.capturedAt - first.capturedAt) / 3_600_000 - xMean;
    covariance += x * (point.usedPercent - yMean);
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

  read(
    range: UsageHistoryRange,
    before: number | undefined,
    now = Date.now(),
  ): UsageLimitHistoryResponse {
    const period = usageHistoryPeriod(range, Math.min(before ?? now, now));
    const identities = this.db
      .prepare(
        `SELECT limit_id,window_kind
         FROM usage_sample
         WHERE captured_at>=? AND captured_at<?
         GROUP BY limit_id,window_kind
         ORDER BY limit_id,window_kind
         LIMIT ${MAX_SERIES}`,
      )
      .all(period.periodStart, period.periodEnd) as UsageRow[];
    const series = identities.flatMap((identity) => {
      const limitId = String(identity.limit_id);
      const windowKind = String(identity.window_kind) as
        | 'primary'
        | 'secondary';
      const latest = this.db
        .prepare(
          `SELECT limit_name,window_label,window_minutes
           FROM usage_sample
           WHERE limit_id=? AND window_kind=? AND captured_at<?
           ORDER BY captured_at DESC,id DESC LIMIT 1`,
        )
        .get(limitId, windowKind, period.periodEnd) as UsageRow | undefined;
      if (!latest) return [];
      const prior = this.db
        .prepare(
          `SELECT captured_at,used_percent,resets_at
           FROM usage_sample
           WHERE limit_id=? AND window_kind=? AND captured_at<?
           ORDER BY captured_at DESC,id DESC LIMIT 1`,
        )
        .get(limitId, windowKind, period.periodStart) as UsageRow | undefined;
      const rows = this.db
        .prepare(
          `SELECT captured_at,used_percent,resets_at
           FROM usage_sample
           WHERE limit_id=? AND window_kind=? AND captured_at>=? AND captured_at<?
           ORDER BY captured_at,id`,
        )
        .all(
          limitId,
          windowKind,
          period.periodStart,
          period.periodEnd,
        ) as UsageRow[];
      const buckets = new Map<
        number,
        {
          capturedAt: number;
          usedPercent: number;
          consumedPercent: number;
          reset?: boolean;
          resetsAt?: number;
        }
      >();
      let previous = prior ? rawPoint(prior) : undefined;
      for (const row of rows) {
        const current = rawPoint(row);
        const bucketIndex = Math.min(
          period.buckets.length - 1,
          Math.floor(
            (current.capturedAt - period.periodStart) / period.bucketMs,
          ),
        );
        const bucketStart = period.buckets[bucketIndex];
        if (bucketStart === undefined) continue;
        const existing = buckets.get(bucketStart);
        const reset = previous
          ? isUsageResetBoundary(previous, current)
          : false;
        const increase = reset
          ? current.usedPercent
          : previous
            ? Math.max(0, current.usedPercent - previous.usedPercent)
            : 0;
        buckets.set(bucketStart, {
          capturedAt: current.capturedAt,
          usedPercent: current.usedPercent,
          consumedPercent: (existing?.consumedPercent ?? 0) + increase,
          ...(existing?.reset || reset ? { reset: true } : {}),
          ...(current.resetsAt === undefined
            ? {}
            : { resetsAt: current.resetsAt }),
        });
        previous = current;
      }
      const points = [...buckets].map(([bucketStart, point]) => ({
        bucketStart,
        ...point,
      }));
      if (
        !points.some(
          (point) => point.usedPercent > 0 || point.consumedPercent > 0,
        )
      )
        return [];
      const windowMinutes =
        latest.window_minutes == null
          ? undefined
          : Number(latest.window_minutes);
      const recent =
        period.periodEnd >= now - 2 * 60_000
          ? (this.db
              .prepare(
                `SELECT captured_at,used_percent,resets_at FROM usage_sample
                 WHERE limit_id=? AND window_kind=? AND captured_at<?
                 ORDER BY captured_at DESC,id DESC LIMIT ${BURN_RATE_POINTS}`,
              )
              .all(limitId, windowKind, period.periodEnd)
              .reverse() as UsageRow[])
          : [];
      const rate = burnRate(recent.map(rawPoint), windowMinutes);
      const item: UsageHistorySeries = {
        id: `${limitId}:${windowKind}`,
        limitId,
        limitName: String(latest.limit_name),
        windowKind,
        windowLabel: String(latest.window_label),
        ...(windowMinutes === undefined ? {} : { windowMinutes }),
        points,
        ...(rate === undefined ? {} : { burnRate: rate }),
      };
      return [item];
    });
    return {
      range,
      generatedAt: now,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      bucket: period.bucket,
      buckets: period.buckets,
      series,
    };
  }
}
