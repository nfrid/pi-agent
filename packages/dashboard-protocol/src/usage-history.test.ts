import { describe, expect, it } from 'vitest';
import {
  boundedUsageResetAfterSeconds,
  isUsageResetBoundary,
  MAX_USAGE_TIMESTAMP,
  parseUsageHistoryResponse,
  parseUsageTimestamp,
  tryParseUsageHistoryResponse,
  usageHistoryPeriod,
} from './usage-history.js';

function response() {
  return {
    range: '24h' as const,
    generatedAt: 123,
    periodStart: 0,
    periodEnd: 24 * 60 * 60_000,
    bucket: 'hour' as const,
    buckets: [0],
    series: [
      {
        id: 'codex:primary',
        limitId: 'codex',
        limitName: 'Codex',
        windowKind: 'primary' as const,
        windowLabel: '5h',
        points: [
          {
            bucketStart: 0,
            capturedAt: 100,
            usedPercent: 20,
            consumedPercent: 3,
          },
        ],
        burnRate: { percentPerHour: 2, observedHours: 1 },
      },
    ],
    spend: [
      {
        id: 'openai-codex:gpt-5.6-sol',
        provider: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        label: 'gpt-5.6-sol',
        points: [
          {
            bucketStart: 0,
            calls: 1,
            costUsd: 1,
            inputTokens: 2,
            outputTokens: 3,
            cacheReadTokens: 4,
            cacheWriteTokens: 5,
            totalTokens: 14,
          },
        ],
      },
    ],
  };
}

describe('usage history contracts', () => {
  it('accepts bucketed limit and session-spend series', () => {
    expect(parseUsageHistoryResponse(response())).toMatchObject({
      range: '24h',
      bucket: 'hour',
      series: [{ windowLabel: '5h' }],
      spend: [{ modelId: 'gpt-5.6-sol' }],
    });
  });

  it('keeps the zero-time boundary response schema-valid', () => {
    expect(usageHistoryPeriod('24h', 0)).toMatchObject({
      periodStart: 0,
      periodEnd: 0,
      buckets: [0],
    });
  });

  it('uses fixed buckets for each paged period', () => {
    expect(usageHistoryPeriod('24h', 30 * 24 * 60 * 60_000)).toMatchObject({
      bucket: 'hour',
      buckets: expect.any(Array),
    });
    expect(usageHistoryPeriod('24h', Date.now()).buckets).toHaveLength(24);
    expect(usageHistoryPeriod('7d', Date.now()).buckets).toHaveLength(7);
    expect(usageHistoryPeriod('30d', Date.now())).toMatchObject({
      bucket: 'week',
      buckets: expect.any(Array),
    });
    expect(usageHistoryPeriod('30d', Date.now()).buckets).toHaveLength(5);
  });

  it('normalizes bounded reset timestamps without coercing blanks', () => {
    expect(parseUsageTimestamp('')).toBeUndefined();
    expect(parseUsageTimestamp('   ')).toBeUndefined();
    expect(parseUsageTimestamp(-1)).toBeUndefined();
    expect(parseUsageTimestamp(MAX_USAGE_TIMESTAMP + 1)).toBeUndefined();
    expect(parseUsageTimestamp(1_800_000_000)).toBe(1_800_000_000_000);
    expect(boundedUsageResetAfterSeconds(-1)).toBeUndefined();
    expect(boundedUsageResetAfterSeconds(40_000_000)).toBeUndefined();
    expect(boundedUsageResetAfterSeconds(60)).toBe(60);
  });

  it('requires a percentage drop before treating a newer deadline as a reset', () => {
    expect(
      isUsageResetBoundary(
        { capturedAt: 1, usedPercent: 0, resetsAt: 1_000_000 },
        { capturedAt: 2, usedPercent: 0, resetsAt: 2_000_000 },
      ),
    ).toBe(false);
    expect(
      isUsageResetBoundary(
        { capturedAt: 1, usedPercent: 40, resetsAt: 1_000_000 },
        { capturedAt: 2, usedPercent: 0, resetsAt: 1_000_000 },
      ),
    ).toBe(false);
    expect(
      isUsageResetBoundary(
        { capturedAt: 1, usedPercent: 99, resetsAt: 1_000_000 },
        { capturedAt: 2, usedPercent: 0.4, resetsAt: 2_000_000 },
      ),
    ).toBe(true);
    expect(
      isUsageResetBoundary(
        { capturedAt: 1, usedPercent: 0.4 },
        { capturedAt: 2, usedPercent: 0 },
      ),
    ).toBe(true);
  });

  it('rejects oversized or out-of-range history data', () => {
    const base = response();
    expect(
      tryParseUsageHistoryResponse({
        ...base,
        buckets: Array.from({ length: 32 }, (_, index) => index),
      }),
    ).toBeUndefined();
    for (const point of [
      { ...base.series[0]?.points[0], usedPercent: 101 },
      {
        ...base.series[0]?.points[0],
        capturedAt: MAX_USAGE_TIMESTAMP + 1,
      },
      { ...base.series[0]?.points[0], resetsAt: -1 },
    ])
      expect(
        tryParseUsageHistoryResponse({
          ...base,
          series: [{ ...base.series[0], points: [point] }],
        }),
      ).toBeUndefined();
  });
});
