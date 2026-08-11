import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { formatUsage } from './display';
import type { UsageReport } from './types';

const ctx = {
  model: { provider: 'openai-codex', id: 'gpt-test', name: 'gpt-test' },
  ui: {
    theme: {
      fg: (_color: unknown, text: string) => text,
      italic: (text: string) => text,
    },
  },
} as unknown as ExtensionContext;

describe('usage display', () => {
  it('keeps window labels and reset countdowns visible', () => {
    const report: UsageReport = {
      capturedAt: Date.now(),
      snapshots: [
        {
          limitId: 'codex',
          primary: {
            usedPercent: 12,
            windowMinutes: 300,
            resetsAt: Date.now() + 61 * 60_000,
          },
          secondary: {
            usedPercent: 34,
            windowMinutes: 10_080,
            resetsAt: Date.now() + 3 * 24 * 60 * 60_000,
          },
        },
      ],
    };

    expect(formatUsage(report, ctx)).toMatch(/5h 12% .*reset 1h/);
    expect(formatUsage(report, ctx)).toMatch(/wk 34% .*reset 3d/);
  });

  it('uses reported duration for an otherwise unknown window', () => {
    const report: UsageReport = {
      capturedAt: Date.now(),
      snapshots: [
        {
          limitId: 'codex',
          primary: { usedPercent: 9, windowMinutes: 45 },
        },
      ],
    };
    expect(formatUsage(report, ctx)).toContain('45m 9%');
  });
});
