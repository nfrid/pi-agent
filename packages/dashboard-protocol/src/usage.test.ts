import { describe, expect, it } from 'vitest';
import { normalizeUsage } from './usage.js';

describe('usage contract normalization', () => {
  it('normalizes backend primary and additional rate limits in order', () => {
    expect(
      normalizeUsage(
        {
          rate_limit: {
            primary_window: {
              used_percent: 12,
              limit_window_seconds: 18_001,
              reset_at: 100,
            },
          },
          additional_rate_limits: [
            {
              metered_feature: 'review',
              limit_name: 'Code review',
              rate_limit: {
                secondary_window: {
                  used_percent: 150,
                  limit_window_seconds: 60,
                  reset_after_seconds: 60,
                },
              },
            },
          ],
        },
        1_000,
      ),
    ).toEqual({
      capturedAt: 1_000,
      snapshots: [
        {
          limitId: 'codex',
          primary: {
            usedPercent: 12,
            windowMinutes: 301,
            windowLabel: '301m',
            resetsAt: 100_000,
          },
        },
        {
          limitId: 'review',
          limitName: 'Code review',
          secondary: {
            usedPercent: 100,
            windowMinutes: 1,
            windowLabel: '1m',
            resetsAt: 61_000,
          },
        },
      ],
    });
  });

  it('merges app-server direct and keyed windows without losing metadata', () => {
    expect(
      normalizeUsage(
        {
          rateLimits: {
            limitId: 'codex',
            limitName: 'Codex',
            primary: {
              usedPercent: 10,
              windowDurationMins: 300,
            },
          },
          rateLimitsByLimitId: {
            codex: {
              secondary: {
                usedPercent: 20,
                windowDurationMins: 10_080,
              },
            },
          },
        },
        1_000,
      ),
    ).toMatchObject({
      capturedAt: 1_000,
      snapshots: [
        {
          limitId: 'codex',
          limitName: 'Codex',
          primary: { usedPercent: 10, windowMinutes: 300, windowLabel: '5h' },
          secondary: {
            usedPercent: 20,
            windowMinutes: 10_080,
            windowLabel: 'wk',
          },
        },
      ],
    });
  });

  it('normalizes snapshots in a nested usage envelope and keeps explicit labels', () => {
    expect(
      normalizeUsage(
        {
          usage: {
            provider: 'openai-codex',
            capturedAt: 2_000,
            snapshots: [
              {
                id: 'weekly-limit',
                name: 'Weekly limit',
                primary_window: {
                  used_percent: 35,
                  window_duration_mins: 45,
                  window_label: 'Custom label',
                  reset_after_seconds: 60,
                },
              },
            ],
          },
        },
        9_000,
      ),
    ).toEqual({
      capturedAt: 2_000,
      provider: 'openai-codex',
      snapshots: [
        {
          limitId: 'weekly-limit',
          limitName: 'Weekly limit',
          primary: {
            usedPercent: 35,
            windowMinutes: 45,
            windowLabel: 'Custom label',
            resetsAt: 62_000,
          },
        },
      ],
    });
  });

  it('is idempotent for normalized values and rejects unknown payloads', () => {
    expect(
      normalizeUsage({ capturedAt: 123, snapshots: [], provider: 'codex' }),
    ).toEqual({ capturedAt: 123, snapshots: [], provider: 'codex' });
    const report = normalizeUsage(
      { snapshots: [{ primary: { usedPercent: 10, resetAfterSeconds: 60 } }] },
      1_000,
    );
    expect(normalizeUsage(report)).toEqual(report);
    expect(() => normalizeUsage({ rateLimits: { primary: {} } })).toThrow(
      'no rate-limit windows',
    );
  });
});
