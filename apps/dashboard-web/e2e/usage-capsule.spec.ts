import { expect, type Page, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

const usage = {
  capturedAt: Date.now(),
  snapshots: [
    {
      limitId: 'codex',
      primary: {
        usedPercent: 73,
        windowDurationMins: 10_080,
        resetsAt: Date.now() + 3 * 24 * 60 * 60_000,
      },
    },
  ],
};

async function openSession(page: Page) {
  await page.route('**/api/usage', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ usage }),
    }),
  );
  await page.route('**/api/sessions/session-usage/delegate-history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ invocations: [] }),
    }),
  );
  await installDashboardBootstrap(page, {
    serverId: 'dashboard-usage',
    revision: 1,
    cursor: 1,
    runtimes: [
      {
        runtimeId: 'runtime-usage',
        ownership: 'external',
        pid: 1,
        cwd: '/tmp/usage',
        liveState: 'working',
        online: true,
        session: {
          id: 'session-usage',
          title: 'Usage session',
          entries: [],
        },
        pendingInteractions: [],
      },
    ],
    workspaces: [],
    sessions: [
      {
        id: 'session-usage',
        file: '',
        cwd: '/tmp/usage',
        title: 'Usage session',
        updatedAt: Date.now(),
      },
    ],
    unread: [],
    usage,
  });
  await page.goto('/sessions/session-usage');
}

async function expectNoHeaderOverlap(page: Page) {
  const usageBox = await page.locator('.global-usage').boundingBox();
  const actionsBox = await page
    .locator('.session-heading-actions')
    .boundingBox();
  if (!usageBox || !actionsBox)
    throw new Error('Session header controls are not laid out.');
  expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(usageBox.x);
}

test('keeps compact usage visible in mobile sessions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await openSession(page);
  const trigger = page.getByRole('button', { name: 'Usage: weekly 73%' });
  await expect(trigger).toBeVisible();
  await expect(trigger.getByText('weekly')).toBeHidden();
  await expectNoHeaderOverlap(page);
});

test('keeps usage visible beside the desktop session header @desktop', async ({
  page,
}) => {
  await openSession(page);
  const trigger = page.getByRole('button', { name: 'Usage: weekly 73%' });
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText('weekly');
  await expectNoHeaderOverlap(page);
  await trigger.click();
  await expect(
    page.getByRole('dialog', { name: 'Usage limits' }),
  ).toBeVisible();
});
