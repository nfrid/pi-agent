import { expect, type Page, test } from '@playwright/test';
import { trpcData, trpcSseData } from './dashboard-fixtures';
import {
  buildActivityPanelScenario,
  installVisualStateScenario,
} from './visual-state-fixtures';

const jobId = '123e4567-e89b-12d3-a456-426614174001';
const job = {
  id: jobId,
  sessionId: 'working-session',
  title: 'Dev server',
  command: 'printf live-output',
  cwd: '/workspace/dashboard',
  events: true,
  status: 'running',
  createdAt: Date.parse('2026-08-30T11:59:00.000Z'),
  stdout: { totalBytes: 0, droppedBytes: 0 },
  stderr: { totalBytes: 0, droppedBytes: 0 },
};

async function installBackgroundScenario(page: Page) {
  const scenario = buildActivityPanelScenario(true);
  await installVisualStateScenario(page, scenario);
  let logSubscriptions = 0;
  await page.route('**/trpc/backgroundJobs', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: trpcData({ sessionId: 'working-session', jobs: [job] }),
    }),
  );
  await page.route('**/trpc/backgroundJobsSubscribe*', async (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: trpcSseData(
        { sessionId: 'working-session', jobs: [job] },
        'background-jobs-test-1',
      ),
    }),
  );
  await page.route('**/trpc/backgroundJobEventsSubscribe*', async (route) => {
    logSubscriptions += 1;
    await route.fulfill({
      contentType: 'text/event-stream',
      body:
        'event: connected\ndata: {"reconnectAfterInactivityMs":60000}\n\n' +
        `id: background-log-${jobId}-1\ndata: ${JSON.stringify({
          sessionId: 'working-session',
          jobId,
          events: [
            {
              offset: 0,
              stream: 'stdout',
              text: '<script>safe-output</script>\n',
              truncated: false,
            },
          ],
          truncated: false,
          complete: false,
          nextOffset: 1,
        })}\n\n` +
        `id: background-log-${jobId}-2\ndata: ${JSON.stringify({
          sessionId: 'working-session',
          jobId,
          events: [
            {
              offset: 1,
              stream: 'stderr',
              text: 'appended-error\n',
              truncated: false,
            },
          ],
          truncated: false,
          complete: true,
          nextOffset: 2,
        })}\n\n`,
    });
  });
  await page.reload();
  return {
    panel: page.locator('.activity-panel'),
    logSubscriptionCount: () => logSubscriptions,
  };
}

async function openActivity(page: Page) {
  const panel = page.locator('.activity-panel');
  if (!(await panel.isVisible()))
    await page.getByRole('button', { name: 'Open session activity' }).click();
  await expect(panel).toBeVisible();
  return panel;
}

async function openAndCheckLogs(page: Page) {
  const panel = await openActivity(page);
  const section = panel.getByRole('region', {
    name: 'Background',
    exact: true,
  });
  await expect(section).toBeVisible();
  await expect(
    section.getByRole('status', {
      name: '1 running, 0 failed, 0 stopped, 0 done',
    }),
  ).toBeVisible();
  const row = section.getByRole('button', { name: /Dev server/ });
  await expect(section).not.toContainText('printf live-output');
  await expect(section).not.toContainText('exit');
  await row.click();
  const inspector = page.getByRole('dialog', {
    name: 'Background · Dev server',
  });
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText('printf live-output');
  const log = inspector.getByRole('log', { name: 'Dev server output' });
  await expect(log).toContainText('<script>safe-output</script>');
  await expect(log).toContainText('appended-error');
  await expect(inspector).toContainText('Logs complete.');
  expect(
    (await page.locator('script').allTextContents()).join('\n'),
  ).not.toContain('safe-output');
  return { panel, section, row, inspector };
}

test('opens Background logs in a separate surface, appends live output safely, and cleans up on close', async ({
  page,
}) => {
  const scenario = await installBackgroundScenario(page);
  const { inspector, row } = await openAndCheckLogs(page);
  expect(scenario.logSubscriptionCount()).toBe(1);
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
  await row.click();
  await expect(
    page.getByRole('dialog', { name: 'Background · Dev server' }),
  ).toBeVisible();
  expect(scenario.logSubscriptionCount()).toBe(2);
});

test('renders Background activity and live logs in its inspector on desktop @desktop', async ({
  page,
}) => {
  await installBackgroundScenario(page);
  const { inspector } = await openAndCheckLogs(page);
  await expect(page.locator('.activity-panel')).toBeVisible();
  await expect(inspector).toBeVisible();
  const typography = await page.evaluate(() => {
    const titles = Array.from(
      document.querySelectorAll('.activity-panel .delegate-row-main strong'),
    );
    const backgroundCommand = document.querySelector(
      '.background-inspector-details code',
    );
    if (titles.length < 2 || !backgroundCommand)
      throw new Error('background typography missing');
    return {
      titleFonts: titles.map((title) => getComputedStyle(title).fontFamily),
      titleSizes: titles.map((title) => getComputedStyle(title).fontSize),
      commandFont: getComputedStyle(backgroundCommand).fontFamily,
    };
  });
  expect([...new Set(typography.titleFonts)]).toHaveLength(1);
  expect([...new Set(typography.titleSizes)]).toHaveLength(1);
  expect(typography.commandFont).toContain('monospace');
});
