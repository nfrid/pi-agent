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

const usageHistory = {
  generatedAt: Date.now(),
  series: [
    {
      limitId: 'codex',
      limitName: 'Codex',
      windowKind: 'primary',
      windowLabel: '5h',
      windowMinutes: 300,
      points: [
        { capturedAt: Date.now() - 2 * 60 * 60_000, usedPercent: 18 },
        { capturedAt: Date.now() - 60 * 60_000, usedPercent: 45 },
        {
          capturedAt: Date.now(),
          usedPercent: 73,
          resetsAt: usage.snapshots[0]?.primary.resetsAt,
        },
      ],
      burnRate: {
        percentPerHour: 27.5,
        observedHours: 2,
        projectedExhaustionAt: Date.now() + 60 * 60_000,
        exhaustsBeforeReset: true,
      },
    },
    {
      limitId: 'codex',
      limitName: 'Codex',
      windowKind: 'secondary',
      windowLabel: 'wk',
      windowMinutes: 10_080,
      points: [
        { capturedAt: Date.now() - 2 * 24 * 60 * 60_000, usedPercent: 20 },
        { capturedAt: Date.now() - 24 * 60 * 60_000, usedPercent: 30 },
        {
          capturedAt: Date.now(),
          usedPercent: 41,
          resetsAt: usage.snapshots[0]?.secondary.resetsAt,
        },
      ],
      burnRate: {
        percentPerHour: 0.45,
        observedHours: 24,
        projectedExhaustionAt: Date.now() + 6 * 24 * 60 * 60_000,
        exhaustsBeforeReset: false,
      },
    },
  ],
};

async function openSession(
  page: Page,
  path = '/sessions/session-usage',
  usageValue: unknown = usage,
) {
  await page.route('**/api/usage/history?*', (route) => {
    const range = new URL(route.request().url()).searchParams.get('range');
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ...usageHistory, range }),
    });
  });
  await page.route('**/api/usage', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ usage: usageValue }),
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
      usage: usageValue,
    },
    { usage: usageValue },
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

test('selects the most urgent limit and keeps every limit in quick history', async ({
  page,
}) => {
  await openSession(page, '/', {
    capturedAt: Date.now(),
    snapshots: [
      ...usage.snapshots,
      {
        limitId: 'reviews',
        limitName: 'Reviews',
        primary: {
          usedPercent: 99,
          windowDurationMins: 300,
          resetsAt: Date.now() + 60 * 60_000,
        },
      },
    ],
  });
  await page.getByRole('button', { name: 'Open agent list' }).click();
  const trigger = page.getByRole('button', {
    name: 'Usage: Reviews, 5h 99%',
  });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const details = page.getByRole('dialog', { name: 'Usage limits' });
  await expect(details.getByText('Codex history')).toBeVisible();
  await expect(details.getByText('Reviews history')).toBeVisible();
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
  const details = page.getByRole('dialog', { name: 'Usage limits' });
  await expect(details).toBeVisible();
  const settings = page.getByRole('button', { name: 'Open settings' });
  await settings.focus();
  await expect(settings).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await expect(page.locator('.agent-nav-drawer.open')).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(details).toBeVisible();
  await page.keyboard.press('Control+K');
  const palette = page.locator('.command-palette');
  await expect(palette).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await expect(details).toBeVisible();
  await expect(page.locator('.agent-nav-drawer.open')).toBeVisible();
  await expect(page.locator('.command-palette')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await expect(page.locator('.agent-nav-drawer.open')).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(details).toBeVisible();
  await details.getByRole('button', { name: 'Open usage analytics' }).click();
  const analytics = page.getByRole('dialog', { name: 'Usage analytics' });
  await expect(analytics).toBeVisible();
  await expect
    .poll(async () => (await analytics.boundingBox())?.x)
    .toBeLessThanOrEqual(1);
  const panel = await analytics.boundingBox();
  const viewport = page.viewportSize();
  if (!panel || !viewport)
    throw new Error('Mobile analytics sheet is not laid out.');
  expect(panel.x).toBeLessThanOrEqual(1);
  expect(panel.y).toBeLessThanOrEqual(1);
  expect(Math.abs(panel.width - viewport.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(panel.height - viewport.height)).toBeLessThanOrEqual(2);
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
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await expect(page.locator('.command-palette')).toHaveCount(0);
  await expect(details).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(details).toBeVisible();
  await expect(details.getByText('Codex history')).toBeVisible();
  await expect(details.getByText('73%')).toHaveCount(0);
  await expect(details.getByText('41%')).toHaveCount(0);
  await expect(
    details.getByRole('img', { name: /usage history/iu }),
  ).toHaveCount(2);
  const detailsBox = await details.boundingBox();
  if (!detailsBox) throw new Error('Sidebar usage details are not laid out.');
  expect(detailsBox.y + detailsBox.height).toBeLessThanOrEqual(triggerBox.y);
  await details.getByRole('button', { name: 'Open usage analytics' }).click();
  const analytics = page.getByRole('dialog', { name: 'Usage analytics' });
  await expect(analytics).toBeVisible();
  await expect(analytics).toHaveAttribute('data-surface-kind', 'utility');
  await expect(
    analytics.getByRole('heading', { name: '5h window' }),
  ).toBeVisible();
  await expect(
    analytics.getByRole('heading', { name: 'wk window' }),
  ).toBeVisible();
  await expect(analytics.getByText('27.5%/h')).toBeVisible();
  await expect(analytics.getByText('0.45%/h')).toBeVisible();
  await expect(
    analytics.getByText('Reset should arrive before the limit.'),
  ).toBeVisible();
  await analytics.getByRole('button', { name: '7d' }).click();
  await expect(analytics.getByRole('button', { name: '7d' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.goBack();
  await expect(analytics).toHaveCount(0);
  await expect(trigger).toBeFocused();
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
