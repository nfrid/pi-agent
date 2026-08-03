import { expect, test } from '@playwright/test';

test('mobile dashboard renders and supports the new-agent route', async ({
  page,
}) => {
  await page.route('**/api/snapshot', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        revision: 1,
        runtimes: [],
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
