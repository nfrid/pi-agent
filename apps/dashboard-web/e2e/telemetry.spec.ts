import { expect, test } from '@playwright/test';
import {
  dashboardTrpcInput,
  installDashboardBootstrap,
  trpcData,
} from './dashboard-fixtures';

test('diagnostics groups issues and accepts explicit local reports', async ({
  page,
}) => {
  await installDashboardBootstrap(page, {
    serverId: 'telemetry-server',
    revision: 1,
    cursor: 1,
    runtimes: [],
    sessions: [],
    unread: [],
  });
  const issue = {
    source: 'harness',
    operation: 'delegate.lifecycle',
    code: 'timeout',
    outcome: 'failure',
    count: 3,
    attempts: 10,
    failures: 3,
    firstSeen: 1,
    lastSeen: 2,
    samples: [
      {
        id: 1,
        timestamp: 2,
        source: 'harness',
        operation: 'delegate.lifecycle',
        code: 'timeout',
        outcome: 'failure',
        version: 'release-1',
        sessionId: 'session-1',
        errorName: 'TypeError',
      },
    ],
  };
  const reports: Record<string, unknown>[] = [];
  await page.route('**/trpc/telemetryOverview', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        available: true,
        retentionDays: 30,
        maxEvents: 10_000,
        eventCount: 10,
        observationCount: 12,
        firstTimestamp: 1,
        lastTimestamp: 2,
        issues: [issue, { ...issue, code: 'cancelled', outcome: 'expected' }],
      }),
    }),
  );
  await page.route('**/trpc/telemetryReport', (route) => {
    expect(route.request().headers()['x-dashboard-token']).toBe('test-token');
    reports.push(dashboardTrpcInput(route.request()));
    return route.fulfill({
      contentType: 'application/json',
      body: trpcData({ accepted: true }),
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Diagnostics', exact: true }),
  ).toBeVisible();
  const recorded = page.getByRole('article', {
    name: 'delegate.lifecycle: timeout',
  });
  const retainedWindow = await page.evaluate(
    ([first, last]) =>
      `Retained window: ${new Date(first).toLocaleString()} to ${new Date(last).toLocaleString()}.`,
    [1, 2],
  );
  await expect(page.getByText(retainedWindow, { exact: false })).toBeVisible();
  await expect(
    page.getByText(/up to 10,000 stored records for up to 30 days/),
  ).toBeVisible();
  await expect(
    page.getByText('10 stored records represent 12 occurrences.'),
  ).toBeVisible();
  await expect(recorded).toContainText('3 occurrences');
  await expect(recorded).toContainText('3 failures / 10 recorded outcomes');
  await expect(
    page.getByRole('article', { name: 'delegate.lifecycle: cancelled' }),
  ).toHaveCount(0);
  await page.getByRole('checkbox', { name: /Show expected outcomes/ }).check();
  await expect(
    page.getByRole('article', { name: 'delegate.lifecycle: cancelled' }),
  ).toBeVisible();
  await recorded.getByText('Recent samples', { exact: true }).click();
  await expect(recorded).toContainText('Error class: TypeError');
  await expect(
    recorded.getByRole('link', { name: 'Open local session' }),
  ).toHaveAttribute('href', '/sessions/session-1');
  await page.getByLabel('What went wrong?').fill('The toolbar stayed stale.');
  await page.getByRole('button', { name: 'Save local report' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Quirk recorded locally.',
  );
  expect(
    reports.some(
      (report) =>
        report.code === 'manual-report' &&
        report.note === 'The toolbar stayed stale.',
    ),
  ).toBe(true);
  await page.evaluate(() =>
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'PRIVATE PROMPT token=secret',
        filename: 'https://private.example/path',
        error: new TypeError('PRIVATE OUTPUT'),
      }),
    ),
  );
  await expect
    .poll(() => reports.some((report) => report.code === 'uncaught-error'))
    .toBe(true);
  expect(
    reports.find((report) => report.code === 'uncaught-error')?.errorName,
  ).toBe('TypeError');
  await page.evaluate(() =>
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'ResizeObserver loop limit exceeded',
        error: new Error('PRIVATE LOOP MESSAGE'),
      }),
    ),
  );
  await expect
    .poll(() =>
      reports.some((report) => report.code === 'resize-observer-loop'),
    )
    .toBe(true);
  expect(
    JSON.stringify(reports.filter((report) => report.code !== 'manual-report')),
  ).not.toMatch(/PRIVATE|private\.example|secret/);
});

test('terminal history settles stale running delegate summaries and inspectors @desktop', async ({
  page,
}) => {
  const live = {
    id: 'stale-row',
    runId: 'completed-run',
    sessionId: 'child-1',
    lineageId: 'lineage-1',
    name: 'Completed worker',
    kind: 'background',
    state: 'running',
    createdAt: 1,
    startedAt: 2,
    allowWrites: false,
  };
  const session = {
    id: 'parent-1',
    file: '',
    cwd: '/tmp',
    title: 'Delegate regression',
    updatedAt: 1,
  };
  const runtime = {
    runtimeId: 'runtime-1',
    ownership: 'external' as const,
    pid: 1,
    cwd: '/tmp',
    liveState: 'idle' as const,
    session: { ...session, entries: [], entriesComplete: true },
    extensionSurfaces: [
      {
        id: 'delegate.status',
        rendererId: 'delegate.status',
        viewModel: { version: 1, statuses: [live] },
      },
    ],
  };
  await installDashboardBootstrap(page, {
    serverId: 'delegate-server',
    revision: 1,
    cursor: 1,
    runtimes: [runtime] as never,
    sessions: [session],
    unread: [],
  });
  const { id: _liveRowId, ...run } = live;
  const completed = { ...run, state: 'success', finishedAt: 4 };
  await page.route('**/api/sessions/parent-1/delegate-history*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: 2,
        sessionId: 'parent-1',
        groups: [
          { ...completed, id: 'lineage-1', runCount: 1, runs: [completed] },
        ],
      }),
    }),
  );
  await page.route(
    '**/api/sessions/parent-1/delegate-history/runs/completed-run*',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: 1,
          sessionId: 'parent-1',
          lineageId: 'lineage-1',
          runId: 'completed-run',
          run: {
            ...completed,
            details: { response: 'Finished the task.', truncated: false },
          },
        }),
      }),
  );
  await page.goto('/sessions/parent-1');
  const activity = page.locator('.activity-panel');
  if (!(await activity.isVisible()))
    await page.getByRole('button', { name: 'Open session activity' }).click();
  const row = activity.getByRole('button', { name: /Completed worker/ });
  await expect(row).toBeVisible();
  await row.click();
  const inspector = page.getByRole('dialog', {
    name: 'Delegate · Completed worker',
  });
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText('done');
  await expect(inspector).not.toContainText('running');
});
