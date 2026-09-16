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

async function expandAndCheckLogs(page: Page) {
  const panel = await openActivity(page);
  const section = panel.getByRole('region', {
    name: 'Background',
    exact: true,
  });
  await expect(section).toBeVisible();
  const row = section.getByRole('button', { name: /Dev server/ });
  await row.click();
  const log = section.getByRole('log', { name: 'Dev server output' });
  await expect(log).toContainText('<script>safe-output</script>');
  await expect(log).toContainText('appended-error');
  await expect(section).toContainText('Logs complete.');
  expect(
    (await page.locator('script').allTextContents()).join('\n'),
  ).not.toContain('safe-output');
  return { panel, section, row };
}

test('expands Background activity, appends live stdout/stderr safely, and cleans up on collapse', async ({
  page,
}) => {
  const scenario = await installBackgroundScenario(page);
  const { section, row } = await expandAndCheckLogs(page);
  expect(scenario.logSubscriptionCount()).toBe(1);
  await row.click();
  await expect(section.getByRole('log')).toHaveCount(0);
  await row.click();
  await expect(section.getByRole('log')).toBeVisible();
  expect(scenario.logSubscriptionCount()).toBe(2);
});

test('renders Background activity and live logs on desktop @desktop', async ({
  page,
}) => {
  await installBackgroundScenario(page);
  await expandAndCheckLogs(page);
  await expect(page.locator('.activity-panel')).toBeVisible();
});
