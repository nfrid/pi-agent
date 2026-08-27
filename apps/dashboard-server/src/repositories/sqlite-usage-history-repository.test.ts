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
    resetsAt: 10_000_000,
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

  it('records successful refreshes that share a millisecond', () => {
    const history = repository();
    history.append([sample(1_000, 10), sample(1_000, 20)]);
    expect(history.read('all', 2_000).series[0]?.points).toEqual([
      { capturedAt: 1_000, usedPercent: 10, resetsAt: 10_000_000 },
      { capturedAt: 1_000, usedPercent: 20, resetsAt: 10_000_000 },
    ]);
  });

  it('keeps all samples, bounds projections, and derives current-cycle burn', () => {
    const history = repository();
    const start = 1_000_000;
    history.append(
      Array.from({ length: 800 }, (_, index) =>
        sample(
          start + index * 60_000,
          index < 400 ? index / 10 : (index - 400) / 8,
          { resetsAt: index < 400 ? 10_000_000 : 20_000_000 },
        ),
      ),
    );

    const all = history.read('all', start + 800 * 60_000);
    const [series] = all.series;
    expect(series?.points.length).toBeLessThanOrEqual(720);
    expect(series?.points[0]?.capturedAt).toBe(start);
    expect(series?.points.at(-1)?.capturedAt).toBe(start + 799 * 60_000);
    expect(series?.burnRate?.percentPerHour).toBeGreaterThan(7);
    expect(series?.burnRate?.observedHours).toBe(5);
    expect(
      db?.prepare('SELECT COUNT(*) AS count FROM usage_sample').get(),
    ).toEqual({ count: 800 });
  });

  it('filters finite ranges without deleting older history', () => {
    const history = repository();
    const now = 40 * 24 * 60 * 60_000;
    history.append([
      sample(now - 35 * 24 * 60 * 60_000, 10),
      sample(now - 6 * 24 * 60 * 60_000, 20),
      sample(now - 2 * 60 * 60_000, 30),
    ]);

    expect(history.read('24h', now).series[0]?.points).toHaveLength(1);
    expect(history.read('7d', now).series[0]?.points).toHaveLength(2);
    expect(history.read('30d', now).series[0]?.points).toHaveLength(2);
    expect(history.read('all', now).series[0]?.points).toHaveLength(3);
  });
});
