import { expect, test } from '@playwright/test';
import {
  assertNoUnexpectedDashboardApiRequests,
  installDashboardBootstrap,
} from './dashboard-fixtures';

const snapshot = (serverId: string) => ({
  serverId,
  revision: 1,
  cursor: 1,
  runtimes: [],
  workspaces: [],
  sessions: [
    {
      id: 'session-1',
      file: '/tmp/session-1.jsonl',
      cwd: '/tmp',
      updatedAt: 1,
    },
  ],
  unread: [],
});

async function routeLegacySessionReads(page: import('@playwright/test').Page) {
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/session-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/settings', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/threads*', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/sessions/*/delegate-history*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ version: 2, groups: [] }),
    }),
  );
}

const messages = (finalText: string) => [
  {
    type: 'message',
    id: 'request',
    message: {
      id: 'request',
      role: 'user',
      content: [{ type: 'text', text: 'Inspect this' }],
    },
  },
  {
    type: 'message',
    id: 'work',
    message: {
      id: 'work',
      role: 'assistant',
      content: [{ type: 'text', text: 'Working now' }],
    },
  },
  {
    type: 'message',
    id: 'answer',
    message: {
      id: 'answer',
      role: 'assistant',
      content: [{ type: 'text', text: finalText }],
    },
  },
  {
    type: 'custom',
    id: 'closure',
    customType: 'response-closure',
    data: {
      requestMessageId: 'request',
      finalMessageId: 'answer',
      startedAt: 1000,
      endedAt: 91000,
    },
  },
];

test('virtualized outline jumps open the containing work log and keep its anchor @desktop', async ({
  page,
}) => {
  const entries: unknown[] = [
    {
      type: 'message',
      id: 'request',
      message: {
        id: 'request',
        role: 'user',
        content: [{ type: 'text', text: 'Long task request' }],
      },
    },
  ];
  for (let index = 0; index < 88; index += 1) {
    if (index === 40) {
      entries.push(
        {
          type: 'message',
          id: 'steering',
          message: {
            id: 'steering',
            role: 'user',
            timestamp: 410,
            content: [{ type: 'text', text: 'Redirect this step' }],
          },
        },
        {
          type: 'custom',
          id: 'steering-marker',
          customType: 'steering-message',
          data: { timestamp: 410, text: 'Redirect this step' },
        },
      );
    }
    entries.push({
      type: 'message',
      id: `work-${index}`,
      message: {
        id: `work-${index}`,
        role: 'assistant',
        content: [{ type: 'text', text: `Virtual work item ${index}` }],
      },
    });
  }
  entries.push(
    {
      type: 'message',
      id: 'answer',
      message: {
        id: 'answer',
        role: 'assistant',
        content: [{ type: 'text', text: 'Long task complete' }],
      },
    },
    {
      type: 'custom',
      id: 'closure',
      customType: 'response-closure',
      data: {
        requestMessageId: 'request',
        finalMessageId: 'answer',
        startedAt: 1000,
        endedAt: 91000,
      },
    },
  );
  await installDashboardBootstrap(page, snapshot('work-log-virtual'), {
    strictApi: true,
    sessionSnapshot: { entries },
  });
  await routeLegacySessionReads(page);
  await page.goto('/sessions/session-1');
  const workLog = page.getByRole('button', { name: /Work log/ });
  await expect(workLog).toBeVisible();
  await expect(page.getByText('Long task complete')).toBeVisible();
  await page.getByRole('button', { name: /Redirect this step/ }).click();
  await expect(workLog).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Redirect this step')).toBeVisible();
  assertNoUnexpectedDashboardApiRequests(page);
});

for (const project of ['mobile', 'desktop']) {
  test(`response closure folds the work log on ${project}${project === 'desktop' ? ' @desktop' : ''}`, async ({
    page,
  }) => {
    await installDashboardBootstrap(page, snapshot(`work-log-${project}`), {
      strictApi: true,
      sessionSnapshot: { entries: messages('Here is the result') },
    });
    await routeLegacySessionReads(page);
    await page.goto('/sessions/session-1');
    const transcript = page.getByLabel('Transcript', { exact: true });
    await expect(transcript.getByText('Inspect this')).toBeVisible();
    await expect(transcript.getByText('Here is the result')).toBeVisible();
    await expect(transcript.getByText('Working now')).toHaveCount(0);
    const workLog = page.getByRole('button', { name: /Work log.*1m 30s/ });
    await expect(workLog).toBeVisible();
    await workLog.click();
    await expect(transcript.getByText('Working now')).toBeVisible();
    assertNoUnexpectedDashboardApiRequests(page);
  });
}
