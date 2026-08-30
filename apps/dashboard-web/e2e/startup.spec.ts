import { expect, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

const snapshot = {
  serverId: 'incompatible-server',
  revision: 1,
  cursor: 1,
  runtimes: [],
  workspaces: [],
  sessions: [],
  unread: [],
} as const;

test('blocks an incompatible browser shell before auth or routing', async ({
  page,
}) => {
  let shellSnapshotRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/trpc/shellSnapshot'))
      shellSnapshotRequests += 1;
  });
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await installDashboardBootstrap(page, snapshot, {
    protocolInfo: {
      protocolVersion: 1,
      serverId: snapshot.serverId,
      capabilities: { shellSnapshot: true, sessionSnapshot: true },
    },
  });

  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Dashboard update required' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(
    'Dashboard update required',
  );
  await expect(
    page.getByRole('button', { name: 'Reload to update' }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Dashboard token' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Pick a thread to continue' }),
  ).toHaveCount(0);
  expect(shellSnapshotRequests).toBe(0);
});
