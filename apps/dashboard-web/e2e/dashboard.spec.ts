import { expect, test } from '@playwright/test';

test('mobile dashboard renders and supports the new-agent route', async ({
  page,
}) => {
  await page.route('**/api/snapshot', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        revision: 1,
        runtimes: [{ runtimeId: 'ghost', ownership: 'external', pid: 1, cwd: '/tmp', liveState: 'idle', online: false, session: { id: 'ghost-session', entries: [] }, pendingInteractions: [] }],
        workspaces: [
          {
            id: 'w',
            name: 'Demo',
            path: '/tmp',
            canonicalPath: '/tmp',
            source: 'directory',
            active: false,
          },
        ],
        sessions: [],
        unread: [],
      }),
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await expect(page.getByText('Nothing is running yet.')).toBeVisible();
  await expect(page.getByText('ghost-session')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ Agent' })).toBeVisible();
  expect(
    await page
      .locator('body')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.getByRole('button', { name: '+ Agent' }).click();
  await expect(
    page.getByRole('heading', { name: 'Start an agent' }),
  ).toBeVisible();
  await expect(page.getByLabel('Workspace')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start in a new tmux window' }),
  ).toBeVisible();
});

test('dense mobile session keeps conversation and activity readable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.route('**/api/snapshot', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        revision: 1,
        runtimes: [{ runtimeId: 'r1', ownership: 'external', pid: 1, cwd: '/tmp', liveState: 'idle', session: { id: 's1', entries: [] }, pendingInteractions: [] }],
        workspaces: [],
        sessions: [],
        unread: [],
      }),
    }),
  );
  await page.route(/\/api\/sessions\/[^/]+$/, async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        metadata: { id: 's1', file: '', cwd: '/tmp', updatedAt: Date.now() },
        entries: [
          ...Array.from({ length: 30 }, (_, index) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `Earlier message ${index + 1}` }] } })),
          { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Check the dashboard.' }] } },
          { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Checking the mobile transcript.' }, { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'src/App.tsx' } }] } },
          { type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }], isError: false } },
        ],
      }),
    }),
  );
  await page.goto('/sessions/s1');
  await expect(page.getByText('Check the dashboard.')).toBeVisible();
  await expect(page.getByText('Checking the mobile transcript.')).toBeVisible();
  await expect(page.getByText('Explored with read')).toBeVisible();
  await expect(page.getByLabel('Message Pi')).toBeVisible();
  expect(await page.evaluate(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2)).toBe(true);
  expect(await page.locator('body').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
