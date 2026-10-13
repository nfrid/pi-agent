import { expect, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

const snapshot = {
  serverId: 'delegate-sidebar-filter',
  revision: 1,
  cursor: 1,
  unread: [],
  runtimes: [
    {
      runtimeId: 'delegate-online',
      ownership: 'external' as const,
      pid: 41,
      cwd: '/tmp/online',
      liveState: 'working' as const,
      online: true,
      session: { id: 'delegate-online-session', entries: [] },
    },
    {
      runtimeId: 'delegate-offline',
      ownership: 'external' as const,
      pid: 42,
      cwd: '/tmp/offline',
      liveState: 'idle' as const,
      online: false,
      session: { id: 'delegate-offline-session', entries: [] },
    },
    {
      runtimeId: 'external-user',
      ownership: 'external' as const,
      pid: 43,
      cwd: '/tmp/external',
      liveState: 'idle' as const,
      online: true,
      session: {
        id: 'external-user-session',
        title: 'External user session',
        entries: [],
      },
    },
  ],
  sessions: [
    {
      id: 'parent-session',
      file: '/tmp/parent-session.jsonl',
      cwd: '/tmp/parent',
      title: 'Ordinary parent session',
      updatedAt: 3,
    },
    {
      id: 'delegate-online-session',
      file: '',
      cwd: '/tmp/online',
      sessionKind: 'delegate',
      title: 'Unindexed delegate online',
      updatedAt: 2,
    },
    {
      id: 'delegate-offline-session',
      file: '',
      cwd: '/tmp/offline',
      sessionKind: 'delegate',
      title: 'Unindexed delegate offline',
      updatedAt: 1,
    },
  ],
} satisfies import('@pi-dashboard/protocol').BrowserSnapshot;

for (const suffix of ['', ' @desktop']) {
  test(`top-level sidebar filters fallback delegate metadata but keeps external runtimes${suffix}`, async ({
    page,
  }) => {
    await installDashboardBootstrap(page, snapshot);
    await page.goto('/');

    const sidebar = page.locator('aside');
    await expect(sidebar.getByText('Ordinary parent session')).toBeVisible();
    await expect(sidebar.getByText('External user session')).toBeVisible();
    await expect(
      sidebar.getByRole('button', { name: /Untitled session/ }),
    ).toHaveCount(0);
    await expect(sidebar.getByText('Unindexed delegate online')).toHaveCount(0);
    await expect(sidebar.getByText('Unindexed delegate offline')).toHaveCount(
      0,
    );
  });
}
