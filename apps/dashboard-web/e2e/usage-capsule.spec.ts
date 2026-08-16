import { expect, type Page, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

const usage = {
  capturedAt: Date.now(),
  snapshots: [
    {
      limitId: 'codex',
      primary: {
        usedPercent: 73,
        windowDurationMins: 300,
        resetsAt: Date.now() + 3 * 60 * 60_000,
      },
      secondary: {
        usedPercent: 41,
        windowDurationMins: 10_080,
        resetsAt: Date.now() + 3 * 24 * 60 * 60_000,
      },
    },
  ],
};

async function openSession(page: Page, path = '/sessions/session-usage') {
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
  await page.goto(path);
}

test('keeps usage in the global toolbar on non-session routes', async ({
  page,
}) => {
  await openSession(page, '/');
  const trigger = page.getByRole('button', {
    name: 'Usage: 5h 73%, wk 41%',
  });
  await expect(page.locator('.global-tools .global-usage')).toHaveCount(1);
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText('5h');
  await expect(trigger).toContainText('wk');
});

test('shows usage in the mobile agent drawer, not the session toolbar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await openSession(page);
  await expect(page.locator('.global-tools .global-usage')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open agent list' }).click();
  const trigger = page.getByRole('button', {
    name: 'Usage: 5h 73%, wk 41%',
  });
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText('5h');
  await expect(trigger).toContainText('wk');
  await trigger.click();
  await expect(
    page.getByRole('dialog', { name: 'Usage limits' }),
  ).toBeVisible();
});

test('shows usage in the desktop sidebar, not the session toolbar @desktop', async ({
  page,
}) => {
  await openSession(page);
  await expect(page.locator('.global-tools .global-usage')).toHaveCount(0);
  const trigger = page.getByRole('button', {
    name: 'Usage: 5h 73%, wk 41%',
  });
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText('5h');
  await expect(trigger).toContainText('wk');
  const sidebar = page.locator('aside.agent-thread-nav-session');
  const footer = sidebar.locator('.agent-nav-footer');
  const triggerBox = await trigger.boundingBox();
  const sidebarBox = await sidebar.boundingBox();
  const footerBox = await footer.boundingBox();
  if (!triggerBox || !sidebarBox || !footerBox)
    throw new Error('Sidebar usage controls are not laid out.');
  const expectedSidebarLeft = sidebarBox.x + 8;
  const expectedSidebarRight = sidebarBox.x + sidebarBox.width - 8;
  const expectedFooterLeft = footerBox.x + 8;
  const expectedFooterRight = footerBox.x + footerBox.width - 8;
  for (const [actual, expected] of [
    [triggerBox.x, expectedSidebarLeft],
    [triggerBox.x + triggerBox.width, expectedSidebarRight],
    [triggerBox.x, expectedFooterLeft],
    [triggerBox.x + triggerBox.width, expectedFooterRight],
  ]) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2);
  }
  await trigger.click();
  const details = page.getByRole('dialog', { name: 'Usage limits' });
  await expect(details).toBeVisible();
  const detailsBox = await details.boundingBox();
  if (!detailsBox) throw new Error('Sidebar usage details are not laid out.');
  expect(detailsBox.y + detailsBox.height).toBeLessThanOrEqual(triggerBox.y);
});
