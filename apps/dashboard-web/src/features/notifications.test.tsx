import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NotificationList, UsagePanel } from './notifications';
import {
  formatResetCountdown,
  parseUsage,
  selectUrgentWindow,
  UsageCapsule,
  usageTone,
} from './usage-indicator';

const notifications = Array.from({ length: 10 }, (_, index) => ({
  id: `notice-${index}`,
  kind: 'settled' as const,
  title: `Notice ${index}`,
  body: 'A useful update',
  createdAt: Date.parse('2026-08-05T18:42:00.000Z') + index,
})) as BrowserSnapshot['unread'];

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
});

describe('dashboard notification and usage previews', () => {
  it('discloses the bounded notification slice', () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NotificationList notifications={notifications} />
      </QueryClientProvider>,
    );
    expect(markup).toContain('newest of 10 unread notifications');
    expect(markup.match(/<article/g)).toHaveLength(8);
    expect(markup).toContain('Notice 7');
    expect(markup).not.toContain('Notice 8');
  });

  it('renders an accessible capsule with both usage windows', () => {
    const markup = renderToStaticMarkup(
      <UsageCapsule
        usage={{
          snapshots: [
            {
              limitId: 'codex',
              limitName: 'Codex',
              primary: { usedPercent: 25, windowMinutes: 300 },
              secondary: { usedPercent: 75, windowMinutes: 10_080 },
            },
          ],
        }}
      />,
    );
    expect(markup).toContain('aria-label="Usage: 5h 25%, wk 75%"');
    expect(markup).toContain('aria-label="Usage limits"');
    expect(markup).toContain('5h');
    expect(markup).toContain('wk');
    expect(markup).toContain('Codex usage');
  });

  it('shows a rate-limit reset time when the provider reports one', () => {
    const markup = renderToStaticMarkup(
      <UsagePanel
        usage={{
          snapshots: [
            {
              limitId: 'codex',
              primary: {
                used_percent: 25,
                reset_at: Date.parse('2026-08-05T19:00:00.000Z') / 1_000,
              },
              secondary: {
                usedPercent: 60,
                resetsAt: Date.parse('2026-08-12T19:00:00.000Z'),
              },
            },
          ],
        }}
      />,
    );
    expect(markup).toContain('25% used');
    expect(markup).toContain('resets');
    expect(markup).toContain('2026-08-05T19:00:00.000Z');
    expect(markup).toContain('60% used');
    expect(markup).toContain('2026-08-12T19:00:00.000Z');
  });
});
