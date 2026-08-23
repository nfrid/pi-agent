import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  formatResetCountdown,
  parseUsage,
  selectUrgentWindow,
  UsageCapsule,
  usageTone,
} from './usage-indicator';

describe('usage parsing and formatting', () => {
  it('normalizes both windows and seconds or milliseconds reset timestamps', () => {
    const [limit] = parseUsage({
      snapshots: [
        {
          limitId: 'codex',
          primary: { used_percent: 50, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 91, reset_at: 1_800_000_000_000 },
        },
      ],
    });
    expect(limit).toMatchObject({
      primary: { usedPercent: 50, resetsAt: 1_800_000_000_000 },
      secondary: { usedPercent: 91, resetsAt: 1_800_000_000_000 },
    });
  });

  it('uses restrained boundary colors and chooses the urgent window', () => {
    expect([49, 50, 70, 71, 90, 91].map(usageTone)).toEqual([
      'neutral',
      'green',
      'green',
      'amber',
      'amber',
      'red',
    ]);
    const secondary = {
      kind: 'secondary' as const,
      label: 'wk',
      usedPercent: 85,
    };
    expect(
      selectUrgentWindow([
        { kind: 'primary', label: '5h', usedPercent: 50 },
        secondary,
      ]),
    ).toBe(secondary);
    expect(formatResetCountdown(Date.now() + 61 * 60_000, Date.now())).toBe(
      'in 1h 1m',
    );
  });

  it('renders both windows and their reset countdowns', () => {
    const markup = renderToStaticMarkup(
      <UsageCapsule
        usage={{
          snapshots: [
            {
              limitId: 'codex',
              limitName: 'Codex',
              primary: {
                usedPercent: 25,
                windowMinutes: 300,
                resetAfterSeconds: 3_600,
              },
              secondary: {
                usedPercent: 75,
                windowMinutes: 10_080,
                resetAfterSeconds: 7_200,
              },
            },
          ],
        }}
      />,
    );
    expect(markup).toContain('aria-label="Usage: 5h 25%, wk 75%"');
    expect(markup).toContain('aria-label="Usage limits"');
    expect(markup).toContain('5h');
    expect(markup).toContain('wk');
    expect(markup).toContain('in 1h');
    expect(markup).toContain('in 2h');
    expect(markup).toContain('Codex usage');
  });
});
