import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsView } from './settings';

const snapshot = {
  unread: [],
  projects: [
    {
      id: 'project-1',
      title: 'Dashboard',
      rootPath: '/tmp/dashboard',
      status: 'active',
    },
  ],
} as unknown as BrowserSnapshot;

describe('settings drawer', () => {
  it('keeps delivery controls and project administration compact', () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsView snapshot={snapshot} />
      </QueryClientProvider>,
    );
    expect(markup).toContain('Alert delivery');
    expect(markup).toContain('Push notifications');
    expect(markup).toContain('Browser alerts');
    expect(markup).toContain('Projects');
    expect(markup).toContain('Dashboard');
    expect(markup).toContain('Rename');
    expect(markup).not.toContain('Remove');
  });
});
