import { describe, expect, it } from 'vitest';
import {
  normalizeAppServerResponse,
  normalizeBackendPayload,
} from './normalize';

describe('usage normalization', () => {
  it('normalizes backend primary and additional rate limits in order', () => {
    const report = normalizeBackendPayload({
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
              used_percent: 34,
              limit_window_seconds: 60,
            },
          },
        },
        { metered_feature: 'ignored', rate_limit: {} },
      ],
    });

    expect(report.snapshots).toEqual([
      {
        limitId: 'codex',
        limitName: undefined,
        primary: { usedPercent: 12, windowMinutes: 301, resetsAt: 100 },
        secondary: undefined,
      },
      {
        limitId: 'review',
        limitName: 'Code review',
        primary: undefined,
        secondary: { usedPercent: 34, windowMinutes: 1, resetsAt: undefined },
      },
    ]);
  });

  it('merges complementary app-server windows without erasing metadata', () => {
    const report = normalizeAppServerResponse({
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 10, windowDurationMins: 300 },
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          secondary: { usedPercent: 20, windowDurationMins: 10_080 },
        },
      },
    });

    expect(report.snapshots).toEqual([
      {
        limitId: 'codex',
        limitName: 'Codex',
        primary: {
          usedPercent: 10,
          windowMinutes: 300,
          resetsAt: undefined,
        },
        secondary: {
          usedPercent: 20,
          windowMinutes: 10_080,
          resetsAt: undefined,
        },
      },
    ]);
  });

  it('merges complementary windows in either direction and prefers incoming values', () => {
    const report = normalizeAppServerResponse({
      rateLimits: {
        limitId: 'codex',
        secondary: { usedPercent: 20 },
      },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 30 },
          secondary: { usedPercent: 40 },
        },
      },
    });

    expect(report.snapshots[0]?.primary?.usedPercent).toBe(30);
    expect(report.snapshots[0]?.secondary?.usedPercent).toBe(40);
  });

  it('fails when neither source contains a valid usage window', () => {
    expect(() =>
      normalizeAppServerResponse({
        rateLimits: { primary: { usedPercent: 'invalid' } },
      }),
    ).toThrow('no rate-limit windows');
    expect(() => normalizeBackendPayload({ rate_limit: {} })).toThrow(
      'no rate-limit windows',
    );
  });
});
