import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NotificationList, UsagePanel } from './notifications';

const notifications = Array.from({ length: 10 }, (_, index) => ({
  id: `notice-${index}`,
  kind: 'settled' as const,
  title: `Notice ${index}`,
  body: 'A useful update',
  createdAt: Date.parse('2026-08-05T18:42:00.000Z') + index,
})) as BrowserSnapshot['unread'];

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
            },
          ],
        }}
      />,
    );
    expect(markup).toContain('25% used');
    expect(markup).toContain('resets');
    expect(markup).toContain('2026-08-05T19:00:00.000Z');
  });
});
