import { expect, test } from '@playwright/test';

const snapshot = {
  serverId: 'delegate-history-e2e',
  revision: 1,
  cursor: 1,
  runtimes: [],
  workspaces: [],
  sessions: [
    {
      id: 'historical-session',
      file: '/tmp/historical-session.jsonl',
      cwd: '/tmp',
      updatedAt: 1,
    },
  ],
  unread: [],
};

const metadata = snapshot.sessions[0];

const historicalRun = {
  runId: 'run-e2e',
  lineageId: 'lineage-e2e',
  name: 'Offline historical worker',
  kind: 'background',
  state: 'success',
  createdAt: 1,
  finishedAt: 2,
  allowWrites: false,
};

const history = {
  version: 2,
  sessionId: 'historical-session',
  groups: [
    {
      id: 'lineage-e2e',
      ...historicalRun,
      runCount: 1,
      runs: [historicalRun],
    },
  ],
};

const historyDetail = {
  version: 1,
  sessionId: 'historical-session',
  lineageId: 'lineage-e2e',
  runId: 'run-e2e',
  run: {
    ...historicalRun,
    details: {
      task: 'Inspect the historical fixture',
      activities: [
        {
          type: 'tool',
          label: 'read fixture',
          name: 'read',
          arguments: { path: 'fixture.txt' },
          result: { content: 'historical result' },
          status: 'completed',
        },
      ],
      warnings: ['This transcript is historical.'],
      truncated: true,
    },
  },
};

test('shows and inspects a persisted delegate in an offline session', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('pi-dashboard-token', 'test-token'),
  );
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(snapshot),
    }),
  );
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/events?*', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: '',
    }),
  );
  await page.route(
    '**/api/sessions/historical-session/delegate-history/runs/run-e2e?*',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(historyDetail),
      }),
  );
  await page.route(
    '**/api/sessions/historical-session/delegate-history',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(history),
      }),
  );
  await page.route('**/api/sessions/historical-session', (route) => {
    if (route.request().url().includes('/delegate-history'))
      return route.fallback();
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        metadata,
        entries: [
          { type: 'session', id: 'historical-session', cwd: '/tmp' },
          {
            type: 'message',
            id: 'historical-message',
            message: { role: 'user', content: 'Show persisted delegate work' },
          },
        ],
        entriesComplete: true,
        serverId: 'delegate-history-e2e',
        cursor: 1,
      }),
    });
  });

  await page.goto('/sessions/historical-session');
  const delegateLauncher = page.getByRole('button', {
    name: /Delegates 0 active · 1 finished All delegates complete/,
  });
  await expect(delegateLauncher).toBeVisible();
  await delegateLauncher.click();
  await page.getByRole('button', { name: /Offline historical worker/ }).click();
  await expect(page.getByText('Inspect the historical fixture')).toBeVisible();
  await expect(
    page.getByText('Earlier historical transcript entries were omitted'),
  ).toBeVisible();
});
