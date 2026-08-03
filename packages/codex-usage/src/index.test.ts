import { describe, expect, it } from 'vitest';
import { normalizeUsageResponse, queryViaCodexAppServer } from './index.js';

describe('Codex app-server usage normalization', () => {
  it('accepts rate limits keyed by limit id', () => {
    const report = normalizeUsageResponse({
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 25 } },
        weekly: { secondary_window: { used_percent: 50 } },
      },
    });
    expect(report.snapshots).toEqual([
      { limitId: 'codex', primary: { usedPercent: 25 } },
      { limitId: 'weekly', secondary: { used_percent: 50 } },
    ]);
  });

  it('rejects instead of crashing when codex is unavailable', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(
        queryViaCodexAppServer(new AbortController().signal),
      ).rejects.toThrow(/Could not start codex app-server|ENOENT/);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('merges direct and keyed snapshots by stable limit id', () => {
    const report = normalizeUsageResponse({
      rateLimits: { primary: { usedPercent: 10 } },
      rateLimitsByLimitId: {
        codex: { secondary: { usedPercent: 20 } },
      },
    });
    expect(report.snapshots).toEqual([
      {
        limitId: 'codex',
        primary: { usedPercent: 10 },
        secondary: { usedPercent: 20 },
      },
    ]);
  });
});
