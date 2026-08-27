import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  clampUsagePointIndex,
  UsageSparkline,
  usageProjection,
} from './usage-analytics';
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
    const [invalid] = parseUsage({
      snapshots: [
        {
          primary: {
            usedPercent: 10,
            resetsAt: '',
            resetAfterSeconds: -1,
          },
          secondary: {
            usedPercent: 20,
            resetsAt: -1,
            resetAfterSeconds: 40_000_000,
          },
        },
      ],
    });
    expect(invalid?.primary?.resetsAt).toBeUndefined();
    expect(invalid?.secondary?.resetsAt).toBeUndefined();
    expect(invalid?.primary?.resetAfterSeconds).toBeUndefined();
    expect(invalid?.secondary?.resetAfterSeconds).toBeUndefined();
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
    expect(formatResetCountdown(undefined, Date.now(), -1)).toBeUndefined();
    expect(
      formatResetCountdown(undefined, Date.now(), 40_000_000),
    ).toBeUndefined();
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
  });

  it('selects the globally urgent limit for the capsule', () => {
    const markup = renderToStaticMarkup(
      <UsageCapsule
        usage={{
          snapshots: [
            {
              limitId: 'codex',
              limitName: 'Codex',
              primary: { usedPercent: 20, windowMinutes: 300 },
            },
            {
              limitId: 'reviews',
              limitName: 'Reviews',
              primary: { usedPercent: 95, windowMinutes: 300 },
            },
          ],
        }}
      />,
    );
    expect(markup).toContain('aria-label="Usage: Reviews, 5h 95%"');
    expect(markup).not.toContain('aria-label="Usage: Codex');
  });

  it('clamps a selected chart sample after a shorter refetch', () => {
    expect(clampUsagePointIndex(719, 12)).toBe(11);
    expect(clampUsagePointIndex(-1, 12)).toBe(0);
    expect(clampUsagePointIndex(4, 0)).toBe(0);
  });

  it('keeps elapsed and reset-unknown projections honest', () => {
    expect(
      usageProjection(
        {
          percentPerHour: 10,
          observedHours: 1,
          projectedExhaustionAt: 900,
          exhaustsBeforeReset: true,
        },
        1_000,
      ),
    ).toBe('Limit exhausted.');
    expect(
      usageProjection(
        {
          percentPerHour: 10,
          observedHours: 1,
          projectedExhaustionAt: 3_601_000,
        },
        1_000,
      ),
    ).toBe('Projected limit in 1h. Reset timing unknown.');
  });

  it('renders history as a percentage sparkline without text percentages', () => {
    const markup = renderToStaticMarkup(
      <UsageSparkline
        label="5h"
        points={[
          { capturedAt: 1, usedPercent: 10 },
          { capturedAt: 2, usedPercent: 40 },
        ]}
      />,
    );
    expect(markup).toContain('aria-label="5h usage history"');
    expect(markup).toContain('<path');
    expect(markup).not.toContain('40%');
  });
});
