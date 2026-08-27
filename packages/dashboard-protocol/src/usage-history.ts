import { type Static, Type } from 'typebox';
import { parseSchema, tryParseSchema } from './utils.js';

export const UsageHistoryRangeSchema = Type.Union([
  Type.Literal('24h'),
  Type.Literal('7d'),
  Type.Literal('30d'),
  Type.Literal('all'),
]);
export type UsageHistoryRange = Static<typeof UsageHistoryRangeSchema>;

export const MAX_USAGE_TIMESTAMP = 8_640_000_000_000_000;
export const MAX_USAGE_RESET_AFTER_SECONDS = 366 * 24 * 60 * 60;

export const UsageHistoryPointSchema = Type.Object(
  {
    capturedAt: Type.Number({ minimum: 0, maximum: MAX_USAGE_TIMESTAMP }),
    usedPercent: Type.Number({ minimum: 0, maximum: 100 }),
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
    limitId: Type.String({ minLength: 1, maxLength: 128 }),
    limitName: Type.String({ minLength: 1, maxLength: 256 }),
    windowKind: Type.Union([
      Type.Literal('primary'),
      Type.Literal('secondary'),
    ]),
    windowLabel: Type.String({ minLength: 1, maxLength: 64 }),
    windowMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    points: Type.Array(UsageHistoryPointSchema, { maxItems: 720 }),
    burnRate: Type.Optional(UsageBurnRateSchema),
  },
  { additionalProperties: false },
);
export type UsageHistorySeries = Static<typeof UsageHistorySeriesSchema>;

export const UsageHistoryResponseSchema = Type.Object(
  {
    range: UsageHistoryRangeSchema,
    generatedAt: Type.Number({ minimum: 0, maximum: MAX_USAGE_TIMESTAMP }),
    series: Type.Array(UsageHistorySeriesSchema, { maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type UsageHistoryResponse = Static<typeof UsageHistoryResponseSchema>;

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
  previous: UsageHistoryPoint,
  current: UsageHistoryPoint,
): boolean {
  if (previous.resetsAt !== undefined && current.resetsAt !== undefined)
    return current.resetsAt > previous.resetsAt + 60_000;
  return current.usedPercent < previous.usedPercent;
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
