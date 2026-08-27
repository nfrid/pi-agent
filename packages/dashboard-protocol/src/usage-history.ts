import { type Static, Type } from 'typebox';
import { parseSchema, tryParseSchema } from './utils.js';

export const UsageHistoryRangeSchema = Type.Union([
  Type.Literal('24h'),
  Type.Literal('7d'),
  Type.Literal('30d'),
]);
export type UsageHistoryRange = Static<typeof UsageHistoryRangeSchema>;

export const UsageHistoryBucketSchema = Type.Union([
  Type.Literal('hour'),
  Type.Literal('day'),
  Type.Literal('week'),
]);
export type UsageHistoryBucket = Static<typeof UsageHistoryBucketSchema>;

export const MAX_USAGE_TIMESTAMP = 8_640_000_000_000_000;
export const MAX_USAGE_RESET_AFTER_SECONDS = 366 * 24 * 60 * 60;

export const UsageHistoryPointSchema = Type.Object(
  {
    bucketStart: Type.Number({ minimum: 0, maximum: MAX_USAGE_TIMESTAMP }),
    capturedAt: Type.Number({ minimum: 0, maximum: MAX_USAGE_TIMESTAMP }),
    usedPercent: Type.Number({ minimum: 0, maximum: 100 }),
    consumedPercent: Type.Number({ minimum: 0 }),
    reset: Type.Optional(Type.Boolean()),
    resetsAt: Type.Optional(
      Type.Number({ minimum: 0, maximum: MAX_USAGE_TIMESTAMP }),
    ),
  },
  { additionalProperties: false },
);
export type UsageHistoryPoint = Static<typeof UsageHistoryPointSchema>;

export const UsageBurnRateSchema = Type.Object(
  {
    percentPerHour: Type.Number({ exclusiveMinimum: 0 }),
    observedHours: Type.Number({ exclusiveMinimum: 0 }),
    projectedExhaustionAt: Type.Optional(
      Type.Number({ minimum: 0, maximum: MAX_USAGE_TIMESTAMP }),
    ),
    exhaustsBeforeReset: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type UsageBurnRate = Static<typeof UsageBurnRateSchema>;

export const UsageHistorySeriesSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 260 }),
    limitId: Type.String({ minLength: 1, maxLength: 128 }),
    limitName: Type.String({ minLength: 1, maxLength: 256 }),
    windowKind: Type.Union([
      Type.Literal('primary'),
      Type.Literal('secondary'),
    ]),
    windowLabel: Type.String({ minLength: 1, maxLength: 64 }),
    windowMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    points: Type.Array(UsageHistoryPointSchema, { maxItems: 31 }),
    burnRate: Type.Optional(UsageBurnRateSchema),
  },
  { additionalProperties: false },
);
export type UsageHistorySeries = Static<typeof UsageHistorySeriesSchema>;

export const UsageSpendPointSchema = Type.Object(
  {
    bucketStart: Type.Number({ minimum: 0, maximum: MAX_USAGE_TIMESTAMP }),
    calls: Type.Number({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
    inputTokens: Type.Number({ minimum: 0 }),
    outputTokens: Type.Number({ minimum: 0 }),
    cacheReadTokens: Type.Number({ minimum: 0 }),
    cacheWriteTokens: Type.Number({ minimum: 0 }),
    totalTokens: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type UsageSpendPoint = Static<typeof UsageSpendPointSchema>;

export const UsageSpendSeriesSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 260 }),
    provider: Type.String({ minLength: 1, maxLength: 128 }),
    modelId: Type.String({ minLength: 1, maxLength: 128 }),
    label: Type.String({ minLength: 1, maxLength: 256 }),
    points: Type.Array(UsageSpendPointSchema, { maxItems: 31 }),
  },
  { additionalProperties: false },
);
export type UsageSpendSeries = Static<typeof UsageSpendSeriesSchema>;

export const UsageHistoryResponseSchema = Type.Object(
  {
    range: UsageHistoryRangeSchema,
    generatedAt: Type.Number({ minimum: 0, maximum: MAX_USAGE_TIMESTAMP }),
    periodStart: Type.Number({ minimum: 0, maximum: MAX_USAGE_TIMESTAMP }),
    periodEnd: Type.Number({ minimum: 0, maximum: MAX_USAGE_TIMESTAMP }),
    bucket: UsageHistoryBucketSchema,
    buckets: Type.Array(
      Type.Number({ minimum: 0, maximum: MAX_USAGE_TIMESTAMP }),
      { minItems: 1, maxItems: 31 },
    ),
    series: Type.Array(UsageHistorySeriesSchema, { maxItems: 64 }),
    spend: Type.Array(UsageSpendSeriesSchema, { maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type UsageHistoryResponse = Static<typeof UsageHistoryResponseSchema>;

export const UsageHistoryQuerySchema = Type.Object(
  {
    range: Type.Optional(UsageHistoryRangeSchema),
    before: Type.Optional(
      Type.Number({ minimum: 0, maximum: MAX_USAGE_TIMESTAMP }),
    ),
  },
  { additionalProperties: false },
);
export type UsageHistoryQuery = Static<typeof UsageHistoryQuerySchema>;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export function usageHistoryPeriod(
  range: UsageHistoryRange,
  before: number,
): {
  periodStart: number;
  periodEnd: number;
  bucket: UsageHistoryBucket;
  bucketMs: number;
  buckets: number[];
} {
  const duration =
    range === '24h' ? DAY_MS : range === '7d' ? 7 * DAY_MS : 30 * DAY_MS;
  const bucket: UsageHistoryBucket =
    range === '24h' ? 'hour' : range === '7d' ? 'day' : 'week';
  const bucketMs =
    bucket === 'hour' ? HOUR_MS : bucket === 'day' ? DAY_MS : 7 * DAY_MS;
  const periodEnd = boundedUsageTimestamp(before) ?? Date.now();
  const periodStart = Math.max(0, periodEnd - duration);
  const buckets: number[] = [];
  for (let start = periodStart; start < periodEnd; start += bucketMs)
    buckets.push(start);
  if (buckets.length === 0) buckets.push(periodStart);
  return { periodStart, periodEnd, bucket, bucketMs, buckets };
}

export function boundedUsageTimestamp(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 && value <= MAX_USAGE_TIMESTAMP
    ? value
    : undefined;
}

export function boundedUsageResetAfterSeconds(
  value: number | undefined,
): number | undefined {
  return value !== undefined &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_USAGE_RESET_AFTER_SECONDS
    ? value
    : undefined;
}

export function parseUsageTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number')
    return boundedUsageTimestamp(
      value < 100_000_000_000 ? value * 1_000 : value,
    );
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric))
    return boundedUsageTimestamp(
      numeric < 100_000_000_000 ? numeric * 1_000 : numeric,
    );
  return boundedUsageTimestamp(Date.parse(value));
}

export function isUsageResetBoundary(
  previous: Pick<UsageHistoryPoint, 'capturedAt' | 'usedPercent' | 'resetsAt'>,
  current: Pick<UsageHistoryPoint, 'capturedAt' | 'usedPercent' | 'resetsAt'>,
): boolean {
  if (current.usedPercent >= previous.usedPercent) return false;
  if (previous.resetsAt !== undefined && current.resetsAt !== undefined)
    return current.resetsAt > previous.resetsAt + 60_000;
  return true;
}

export function parseUsageHistoryResponse(
  value: unknown,
): UsageHistoryResponse {
  return parseSchema(
    UsageHistoryResponseSchema,
    value,
    'usage history response',
  );
}

export function tryParseUsageHistoryResponse(
  value: unknown,
): UsageHistoryResponse | undefined {
  return tryParseSchema(UsageHistoryResponseSchema, value);
}
