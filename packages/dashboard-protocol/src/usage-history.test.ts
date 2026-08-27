import { describe, expect, it } from 'vitest';
import {
  boundedUsageResetAfterSeconds,
  isUsageResetBoundary,
  MAX_USAGE_TIMESTAMP,
  parseUsageHistoryResponse,
  parseUsageTimestamp,
  tryParseUsageHistoryResponse,
} from './usage-history.js';

describe('usage history contracts', () => {
  it('accepts the bounded series shape', () => {
    expect(
      parseUsageHistoryResponse({
        range: 'all',
        generatedAt: 123,
        series: [
          {
            limitId: 'codex',
            limitName: 'Codex',
            windowKind: 'primary',
            windowLabel: '5h',
            points: [{ capturedAt: 100, usedPercent: 20 }],
            burnRate: { percentPerHour: 2, observedHours: 1 },
          },
        ],
      }),
    ).toMatchObject({ range: 'all', series: [{ windowLabel: '5h' }] });
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

  it('prefers reset deadlines over percentage drops when finding boundaries', () => {
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
    const base = {
      range: '24h',
      generatedAt: 123,
      series: [
        {
          limitId: 'codex',
          limitName: 'Codex',
          windowKind: 'primary',
          windowLabel: '5h',
          points: Array.from({ length: 721 }, (_, capturedAt) => ({
            capturedAt,
            usedPercent: 20,
          })),
        },
      ],
    };
    expect(tryParseUsageHistoryResponse(base)).toBeUndefined();
    for (const point of [
      { capturedAt: 1, usedPercent: 101 },
      { capturedAt: MAX_USAGE_TIMESTAMP + 1, usedPercent: 20 },
      { capturedAt: 1, usedPercent: 20, resetsAt: -1 },
    ])
      expect(
        tryParseUsageHistoryResponse({
          ...base,
          series: [{ ...base.series[0], points: [point] }],
        }),
      ).toBeUndefined();
  });
});
