import { DatabaseSync } from 'node:sqlite';
import { MAX_USAGE_TIMESTAMP } from '@pi-dashboard/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';
import {
  normalizeUsageHistorySamples,
  SqliteUsageHistoryRepository,
  type UsageHistorySample,
} from './sqlite-usage-history-repository.js';

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function repository() {
  db = new DatabaseSync(':memory:');
  runMigrations(db);
  return new SqliteUsageHistoryRepository(db);
}

function sample(
  capturedAt: number,
  usedPercent: number,
  overrides: Partial<UsageHistorySample> = {},
): UsageHistorySample {
  return {
    capturedAt,
    limitId: 'codex',
    limitName: 'Codex',
    windowKind: 'primary',
    windowLabel: '5h',
    windowMinutes: 300,
    usedPercent,
    resetsAt: 10_000_000_000,
    ...overrides,
  };
}

describe('usage history persistence', () => {
  it('normalizes provider aliases into bounded per-window samples', () => {
    expect(
      normalizeUsageHistorySamples(
        {
          snapshots: [
            {
              limitId: 'codex',
              limitName: 'Codex',
              primary_window: {
                used_percent: 35,
                window_duration_mins: 300,
                reset_after_seconds: 60,
              },
              secondary: {
                usedPercent: 150,
                windowMinutes: 10_080,
                resetsAt: 2_000_000_000,
              },
            },
          ],
        },
        1_000,
      ),
    ).toEqual([
      {
        capturedAt: 1_000,
        limitId: 'codex',
        limitName: 'Codex',
        windowKind: 'primary',
        windowLabel: '5h',
        windowMinutes: 300,
        usedPercent: 35,
        resetsAt: 61_000,
      },
      {
        capturedAt: 1_000,
        limitId: 'codex',
        limitName: 'Codex',
        windowKind: 'secondary',
        windowLabel: 'wk',
        windowMinutes: 10_080,
        usedPercent: 100,
        resetsAt: 2_000_000_000_000,
      },
    ]);
  });

  it('drops provider reset timestamps outside the JavaScript date range', () => {
    const samples = normalizeUsageHistorySamples(
      {
        snapshots: [
          {
            primary: {
              usedPercent: 10,
              resetsAt: -1,
              resetAfterSeconds: -1,
            },
            secondary: {
              usedPercent: 20,
              resetsAt: MAX_USAGE_TIMESTAMP + 1,
              resetAfterSeconds: 40_000_000,
            },
          },
        ],
      },
      1_000,
    );
    expect(samples).toHaveLength(2);
    expect(samples.every((item) => item.resetsAt === undefined)).toBe(true);
  });

  it('keeps same-millisecond refreshes and aggregates their increase', () => {
    const history = repository();
    const now = 2 * 24 * 60 * 60_000;
    history.append([sample(now - 1_000, 10), sample(now - 1_000, 20)]);
    expect(history.read('24h', now, now).series[0]?.points).toEqual([
      {
        bucketStart: expect.any(Number),
        capturedAt: now - 1_000,
        usedPercent: 20,
        consumedPercent: 10,
        resetsAt: 10_000_000_000,
      },
    ]);
  });

  it('buckets a page, keeps durable rows, and derives current-cycle burn', () => {
    const history = repository();
    const now = 20 * 24 * 60 * 60_000;
    const start = now - 12 * 60 * 60_000;
    history.append(
      Array.from({ length: 800 }, (_, index) =>
        sample(start + index * 30_000, index / 10, {
          resetsAt: now + 5 * 60 * 60_000,
        }),
      ),
    );

    const response = history.read('24h', now, now);
    const [series] = response.series;
    expect(response.bucket).toBe('hour');
    expect(response.buckets).toHaveLength(24);
    expect(series?.points.length).toBeLessThanOrEqual(24);
    expect(series?.burnRate?.percentPerHour).toBeGreaterThan(10);
    const boundedRate = series?.burnRate?.percentPerHour;
    history.append([sample(now + 60_000, 99), sample(now + 120_000, 0)]);
    expect(
      history.read('24h', now, now).series[0]?.burnRate?.percentPerHour,
    ).toBe(boundedRate);
    expect(
      db?.prepare('SELECT COUNT(*) AS count FROM usage_sample').get(),
    ).toEqual({ count: 802 });
  });

  it('reads non-overlapping previous pages without deleting older history', () => {
    const history = repository();
    const now = 40 * 24 * 60 * 60_000;
    history.append([
      sample(now - 35 * 24 * 60 * 60_000, 10),
      sample(now - 6 * 24 * 60 * 60_000, 20),
      sample(now - 2 * 60 * 60_000, 30),
    ]);

    expect(history.read('7d', now, now).series[0]?.points).toHaveLength(2);
    expect(
      history.read('7d', now - 7 * 24 * 60 * 60_000, now).series,
    ).toHaveLength(0);
    expect(history.read('30d', now, now).series[0]?.points).toHaveLength(2);
    expect(
      db?.prepare('SELECT COUNT(*) AS count FROM usage_sample').get(),
    ).toEqual({ count: 3 });
  });

  it('counts usage observed immediately after a limit reset', () => {
    const history = repository();
    const now = 3 * 24 * 60 * 60_000;
    history.append([
      sample(now - 2 * 60 * 60_000, 90, { resetsAt: now + 1_000 }),
      sample(now - 60 * 60_000, 5, { resetsAt: now + 4 * 60 * 60_000 }),
      sample(now - 30 * 60_000, 8, { resetsAt: now + 3 * 60 * 60_000 }),
    ]);
    const points = history.read('24h', now, now).series[0]?.points ?? [];
    expect(points.at(-1)).toMatchObject({
      usedPercent: 8,
      consumedPercent: 8,
      reset: true,
    });
  });

  it('does not mark a sliding zero-percent deadline as a reset', () => {
    const history = repository();
    const now = 3 * 24 * 60 * 60_000;
    history.append([
      sample(now - 3 * 60 * 60_000, 5, { resetsAt: now + 1_000 }),
      sample(now - 2 * 60 * 60_000, 0, { resetsAt: now + 3_600_000 }),
      sample(now - 30 * 60_000, 0, { resetsAt: now + 7_200_000 }),
    ]);
    const points = history.read('24h', now, now).series[0]?.points ?? [];
    expect(points.some((point) => point.reset)).toBe(true);
    expect(points.at(-1)?.reset).toBeUndefined();
  });

  it('omits all-zero limit series from the selected period', () => {
    const history = repository();
    const now = 3 * 24 * 60 * 60_000;
    history.append([
      sample(now - 2 * 60 * 60_000, 0),
      sample(now - 60 * 60_000, 0, { resetsAt: 20_000_000_000 }),
    ]);
    expect(history.read('24h', now, now).series).toEqual([]);
  });
});
