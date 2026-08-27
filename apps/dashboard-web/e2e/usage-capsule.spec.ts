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
  await installDashboardBootstrap(
    page,
    {
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
    },
    { usage },
  );
  await page.goto(path);
}

test('keeps usage and settings together in the home sidebar footer', async ({
  page,
}) => {
  await openSession(page, '/');
  await page.getByRole('button', { name: 'Open agent list' }).click();
  const sidebar = page.getByRole('complementary', {
    name: 'Agents and threads',
  });
  const footer = sidebar.locator('.agent-nav-footer');
  await expect(page.locator('.global-tools .usage-capsule')).toHaveCount(0);
  await expect(
    footer.getByRole('button', { name: 'Usage: 5h 73%, wk 41%' }),
  ).toBeVisible();
  await expect(
    footer.getByRole('button', { name: 'Open settings' }),
  ).toBeVisible();
  await expect(footer.getByText('Inbox', { exact: true })).toHaveCount(0);
  await expect(footer.getByText('History', { exact: true })).toHaveCount(0);
});

test('shows compact usage in the mobile agent drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await openSession(page);
  await expect(page.locator('.global-tools .usage-capsule')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open agent list' }).click();
  const trigger = page.getByRole('button', {
    name: 'Usage: 5h 73%, wk 41%',
  });
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText('5h');
  await expect(trigger).toContainText('wk');
  await expect(trigger.getByText('in 3h', { exact: true })).toBeHidden();
  await trigger.click();
  await expect(
    page.getByRole('dialog', { name: 'Usage limits' }),
  ).toBeVisible();
});

test('browser Back closes the mobile agent drawer', async ({ page }) => {
  await openSession(page);
  await page.getByRole('button', { name: 'Open agent list' }).click();
  const agentDrawer = page.locator('.agent-nav-drawer.open');
  await expect(agentDrawer).toBeVisible();

  await page.goBack();

  await expect(agentDrawer).toHaveCount(0);
  await expect(page).toHaveURL(/\/sessions\/session-usage$/u);
});

test('browser Back closes the active settings drawer', async ({ page }) => {
  await openSession(page);
  await page.getByRole('button', { name: 'Open agent list' }).click();
  await page.getByRole('button', { name: 'Open settings' }).click();
  const settingsDrawer = page.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDrawer).toBeVisible();
  await expect(settingsDrawer).toHaveAttribute('data-surface-kind', 'utility');
  await expect
    .poll(async () => (await settingsDrawer.boundingBox())?.x)
    .toBeLessThanOrEqual(1);
  const settingsBox = await settingsDrawer.boundingBox();
  const viewport = page.viewportSize();
  if (!settingsBox || !viewport)
    throw new Error('Mobile settings sheet is not laid out.');
  expect(settingsBox.y).toBeLessThanOrEqual(1);
  expect(Math.abs(settingsBox.width - viewport.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(settingsBox.height - viewport.height)).toBeLessThanOrEqual(2);

  await page.goBack();

  await expect(settingsDrawer).toHaveCount(0);
  await expect(page).toHaveURL(/\/sessions\/session-usage$/u);
});

test('shares the desktop sidebar footer with Settings @desktop', async ({
  page,
}) => {
  await openSession(page);
  await expect(page.locator('.global-tools .usage-capsule')).toHaveCount(0);
  const trigger = page.getByRole('button', {
    name: 'Usage: 5h 73%, wk 41%',
  });
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText('5h');
  await expect(trigger).toContainText('wk');
  await expect(trigger).toContainText('in 3h');
  await expect(trigger).toContainText('in 3d');
  const sidebar = page.locator('aside.agent-thread-nav-session');
  const footer = sidebar.locator('.agent-nav-footer');
  const settings = footer.getByRole('button', { name: 'Open settings' });
  const triggerBox = await trigger.boundingBox();
  const sidebarBox = await sidebar.boundingBox();
  const footerBox = await footer.boundingBox();
  const settingsBox = await settings.boundingBox();
  if (!triggerBox || !sidebarBox || !footerBox || !settingsBox)
    throw new Error('Sidebar footer controls are not laid out.');
  const expectedLeft = footerBox.x + 8;
  const expectedRight = footerBox.x + footerBox.width - 8;
  expect(Math.abs(triggerBox.x - (sidebarBox.x + 8))).toBeLessThanOrEqual(2);
  expect(Math.abs(triggerBox.x - expectedLeft)).toBeLessThanOrEqual(2);
  expect(
    Math.abs(settingsBox.x + settingsBox.width - expectedRight),
  ).toBeLessThanOrEqual(2);
  expect(
    settingsBox.x - (triggerBox.x + triggerBox.width),
  ).toBeGreaterThanOrEqual(5);
  await trigger.click();
  const details = page.getByRole('dialog', { name: 'Usage limits' });
  await expect(details).toBeVisible();
  const detailsBox = await details.boundingBox();
  if (!detailsBox) throw new Error('Sidebar usage details are not laid out.');
  expect(detailsBox.y + detailsBox.height).toBeLessThanOrEqual(triggerBox.y);
  await trigger.click();
  await settings.click();
  const settingsDrawer = page.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDrawer).toBeVisible();
  await expect(settingsDrawer).toHaveAttribute('data-surface-kind', 'utility');
  const panelBox = await settingsDrawer.boundingBox();
  const viewport = page.viewportSize();
  if (!panelBox || !viewport)
    throw new Error('Desktop settings panel is not laid out.');
  expect(panelBox.x).toBeGreaterThanOrEqual(20);
  expect(panelBox.y).toBeGreaterThanOrEqual(20);
  expect(viewport.width - panelBox.x - panelBox.width).toBeGreaterThanOrEqual(
    20,
  );
  expect(viewport.height - panelBox.y - panelBox.height).toBeGreaterThanOrEqual(
    20,
  );
  await expect(
    settingsDrawer.getByRole('heading', { name: 'Alert delivery' }),
  ).toBeVisible();
  await expect(
    settingsDrawer.getByRole('heading', { name: 'Projects' }),
  ).toBeVisible();
  await expect(
    settingsDrawer.getByRole('button', { name: /push/iu }),
  ).toBeVisible();
});
