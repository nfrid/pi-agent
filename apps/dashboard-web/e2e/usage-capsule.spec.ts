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

function usageHistory(range: string, before: number) {
  const duration =
    range === '24h'
      ? 24 * 60 * 60_000
      : range === '7d'
        ? 7 * 24 * 60 * 60_000
        : 30 * 24 * 60 * 60_000;
  const bucket = range === '24h' ? 'hour' : range === '7d' ? 'day' : 'week';
  const bucketMs =
    bucket === 'hour'
      ? 60 * 60_000
      : bucket === 'day'
        ? 24 * 60 * 60_000
        : 7 * 24 * 60 * 60_000;
  const periodStart = before - duration;
  const buckets = Array.from(
    { length: Math.ceil(duration / bucketMs) },
    (_, index) => periodStart + index * bucketMs,
  );
  const limit = (
    id: string,
    windowKind: 'primary' | 'secondary',
    windowLabel: string,
    usedPercent: number,
    burnRate: Record<string, unknown>,
  ) => ({
    id,
    limitId: 'codex',
    limitName: 'Codex',
    windowKind,
    windowLabel,
    windowMinutes: windowKind === 'primary' ? 300 : 10_080,
    points: buckets.map((bucketStart, index) => ({
      bucketStart,
      capturedAt: Math.min(before - 1, bucketStart + bucketMs - 1),
      usedPercent: Math.min(usedPercent, 10 + index * 3),
      consumedPercent: 3,
    })),
    burnRate,
  });
  return {
    range,
    generatedAt: before,
    periodStart,
    periodEnd: before,
    bucket,
    buckets,
    series: [
      limit('codex:primary', 'primary', '5h', 73, {
        percentPerHour: 27.5,
        observedHours: 2,
        projectedExhaustionAt: before + 60 * 60_000,
        exhaustsBeforeReset: true,
      }),
      limit('codex:secondary', 'secondary', 'wk', 41, {
        percentPerHour: 0.45,
        observedHours: 24,
        projectedExhaustionAt: before + 6 * 24 * 60 * 60_000,
        exhaustsBeforeReset: false,
      }),
      {
        ...limit('reviews:primary', 'primary', '5h', 99, {
          percentPerHour: 1,
          observedHours: 1,
        }),
        limitId: 'reviews',
        limitName: 'Reviews',
      },
    ],
    spend: [
      {
        id: 'openai-codex:gpt-5.6-sol',
        provider: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        label: 'gpt-5.6-sol',
        points: buckets.map((bucketStart) => ({
          bucketStart,
          calls: 2,
          costUsd: 1.5,
          inputTokens: 20_000,
          outputTokens: 2_000,
          cacheReadTokens: 40_000,
          cacheWriteTokens: 0,
          totalTokens: 62_000,
        })),
      },
    ],
  };
}

async function openSession(
  page: Page,
  path = '/sessions/session-usage',
  usageValue: unknown = usage,
) {
  await page.route('**/api/usage/history?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const range = query.get('range') ?? '24h';
    const before = Number(query.get('before') ?? Date.now());
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(usageHistory(range, before)),
    });
  });
  await page.route('**/api/usage', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ usage: usageValue }),
    }),
  );
  let customIcon = false;
  await page.route('https://api.iconify.design/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/collection')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ uncategorized: ['star', 'rocket'] }),
      });
    if (url.pathname === '/search')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ icons: ['ph:star'] }),
      });
    const prefix = url.pathname.slice(1, -'.json'.length);
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        prefix,
        width: 256,
        height: 256,
        icons: {
          star: {
            body: '<path d="M128 12 158 94h86l-69 51 26 86-73-50-73 50 26-86-69-51h86z"/>',
          },
          rocket: { body: '<path d="M48 208 208 48l-48 112z"/>' },
        },
      }),
    });
  });
  await page.route('**/api/projects/*/icon/files?*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        suggestions: [
          { value: './assets/', label: 'assets', directory: true },
          { value: './project.svg', label: 'project.svg', directory: false },
        ],
      }),
    }),
  );
  await page.route('**/api/projects/*/icon/project-file', (route) => {
    customIcon = true;
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/projects/*/icon', (route) => {
    const method = route.request().method();
    if (method === 'PUT') {
      customIcon = true;
      return route.fulfill({ status: 204 });
    }
    if (method === 'DELETE') {
      customIcon = false;
      return route.fulfill({ status: 204 });
    }
    return customIcon
      ? route.fulfill({
          status: 200,
          contentType: 'image/svg+xml',
          headers: { 'x-project-icon-source': 'custom' },
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>',
        })
      : route.fulfill({ status: 404 });
  });
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
          projectId: 'project-usage',
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
      projects: [
        {
          id: 'project-usage',
          title: 'Usage project',
          rootPath: '/tmp/usage',
          status: 'active',
          maxParallelRuns: 1,
          activeRunCount: 0,
          updatedAt: 1,
        },
      ],
      sessions: [
        {
          id: 'session-usage',
          file: '',
          cwd: '/tmp/usage',
          projectId: 'project-usage',
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
    analytics.getByRole('radio', { name: 'Limit usage %' }),
  ).toBeChecked();
  await expect(analytics.getByText('visible series')).toHaveCount(0);
  const chart = analytics.getByRole('slider', {
    name: 'Usage analytics interval',
  });
  await expect(chart).toHaveAttribute('aria-valuetext', /Codex 5h.*Codex wk/u);
  await expect(analytics.getByRole('status')).toHaveCount(0);
  await chart.hover();
  await expect(analytics.getByRole('status')).toBeVisible();
  await analytics.getByRole('button', { name: 'Cumulative' }).hover();
  await expect(analytics.getByRole('status')).toHaveCount(0);
  const seriesSelector = analytics.getByRole('button', { name: 'All series' });
  await seriesSelector.click();
  await expect(
    analytics.getByRole('group', { name: 'Visible usage series' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    analytics.getByRole('group', { name: 'Visible usage series' }),
  ).toHaveCount(0);
  await expect(analytics).toBeVisible();
  await expect(seriesSelector).toBeFocused();
  await expect(analytics.getByText('27.50%/h')).toBeVisible();
  await expect(analytics.getByText('0.45%/h')).toBeVisible();
  await expect(
    analytics.getByText('Reset should arrive before the limit.'),
  ).toBeVisible();
  await analytics.getByRole('radio', { name: 'API-equivalent cost' }).check();
  const totals = analytics.getByRole('region', { name: 'Period total' });
  await expect(totals).toContainText('Period total$36');
  await expect(totals).toContainText('gpt-5.6-sol$36');
  await expect(
    analytics.getByText('gpt-5.6-sol', { exact: true }).last(),
  ).toBeVisible();
  await analytics.getByRole('button', { name: 'Cumulative' }).click();
  await expect(
    analytics.getByRole('button', { name: 'Cumulative' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await analytics.getByRole('button', { name: '7d' }).click();
  await expect(analytics.getByRole('button', { name: '7d' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await analytics.getByRole('button', { name: /Previous/ }).click();
  await expect(analytics.getByRole('button', { name: /Next/ })).toBeEnabled();
  await analytics.getByRole('button', { name: /Next/ }).click();
  await expect(analytics.getByRole('button', { name: /Next/ })).toBeDisabled();
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
  await expect(settingsDrawer.getByText('Usage project')).toBeVisible();
  await expect(
    settingsDrawer.getByText('Choose icon', { exact: true }),
  ).toHaveCount(0);
  await expect(
    settingsDrawer.getByRole('button', { name: 'Automatic' }),
  ).toHaveCount(0);
  const iconButton = settingsDrawer.getByRole('button', {
    name: 'Choose icon for Usage project',
  });
  const projectIcon = iconButton.locator('[data-size="small"]');
  await expect(projectIcon).toHaveCSS('width', '26px');
  await expect(projectIcon).toHaveCSS('height', '26px');
  await expect
    .poll(() =>
      settingsDrawer.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    )
    .toBe(true);
  const threadProject = page.locator('[data-row-content="project"]').first();
  await expect(threadProject.locator('[data-size="tiny"]')).toHaveCSS(
    'width',
    '14px',
  );
  await expect(threadProject).toContainText('Usage project');

  await iconButton.click();
  const iconMenu = page.getByRole('dialog', {
    name: 'Icons for Usage project',
  });
  await expect(iconMenu).toBeVisible();
  await expect(
    iconMenu.getByRole('textbox', { name: 'Search icons' }),
  ).toBeVisible();
  await expect(iconMenu.locator('xpath=..')).toHaveAttribute(
    'data-surface-portal-root',
    '',
  );
  await expect(iconMenu).toHaveCSS('position', 'fixed');
  await page.keyboard.press('Escape');
  await expect(iconMenu).toHaveCount(0);

  await iconButton.click();
  const iconSearch = iconMenu.getByRole('textbox', { name: 'Search icons' });
  await expect(iconMenu.locator('[aria-expanded]')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await iconSearch.click();
  await expect(iconSearch).toBeFocused();
  await iconSearch.pressSequentially('star', { delay: 80 });
  await expect(iconSearch).toBeFocused();
  await expect(iconSearch).toHaveValue('star');
  const libraryUpload = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().endsWith('/api/projects/project-usage/icon'),
  );
  await iconMenu.getByTitle('ph:star').click();
  await libraryUpload;
  const resetButton = settingsDrawer.getByRole('button', {
    name: 'Use automatic icon for Usage project',
  });
  await expect(resetButton).toBeAttached();
  await expect(resetButton).toHaveCSS('opacity', '0');
  await iconButton.hover();
  await expect(resetButton).toHaveCSS('opacity', '1');

  let reset = page.waitForRequest(
    (request) =>
      request.method() === 'DELETE' &&
      request.url().endsWith('/api/projects/project-usage/icon'),
  );
  await resetButton.click();
  await reset;
  await expect(resetButton).toHaveCount(0);

  await iconButton.click();
  await iconMenu.getByRole('button', { name: 'Choose project file' }).click();
  await expect(
    iconMenu.getByRole('textbox', { name: 'Search files in Usage project' }),
  ).toHaveValue('./');
  const projectFileUpload = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().endsWith('/api/projects/project-usage/icon/project-file'),
  );
  await iconMenu.getByRole('button', { name: 'project.svg' }).click();
  await projectFileUpload;
  await expect(resetButton).toBeAttached();
  reset = page.waitForRequest(
    (request) =>
      request.method() === 'DELETE' &&
      request.url().endsWith('/api/projects/project-usage/icon'),
  );
  await resetButton.click();
  await reset;

  await iconButton.click();
  const uploaded = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().endsWith('/api/projects/project-usage/icon'),
  );
  const chooser = page.waitForEvent('filechooser');
  await iconMenu.getByText('Upload from device').click();
  await (await chooser).setFiles({
    name: 'project.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>',
    ),
  });
  await uploaded;
  await expect(resetButton).toBeAttached();
  reset = page.waitForRequest(
    (request) =>
      request.method() === 'DELETE' &&
      request.url().endsWith('/api/projects/project-usage/icon'),
  );
  await resetButton.click();
  await reset;
});
