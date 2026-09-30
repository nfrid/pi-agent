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
  const steering = page
    .getByLabel('Transcript', { exact: true })
    .getByText('Redirect this step', { exact: true });
  await expect(steering).toBeInViewport();
  // The disclosure is correctly virtualized away after the jump. Return to
  // the request before checking its retained expanded state.
  await page
    .getByRole('button', { name: 'Long task request', exact: true })
    .click();
  await expect(workLog).toHaveAttribute('aria-expanded', 'true');
  await workLog.click();
  await expect(page.getByText('Long task complete')).toBeVisible();
  assertNoUnexpectedDashboardApiRequests(page);
});

for (const project of ['mobile', 'desktop']) {
  test(`codemode children stay peer rows with a provenance prefix on ${project}${project === 'desktop' ? ' @desktop' : ''}`, async ({
    page,
  }) => {
    const entries: unknown[] = messages('Here is the result');
    entries.splice(
      2,
      0,
      {
        type: 'message',
        id: 'script-declaration',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'script',
              name: 'codemode',
              arguments: {
                code: 'const result = await tools.read({path: "src/one.ts"}); text(result.text);',
              },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'script-result',
        message: {
          role: 'toolResult',
          toolCallId: 'script',
          toolName: 'codemode',
          isError: false,
          content: [{ type: 'text', text: 'Selected script output' }],
          nestedCalls: {
            complete: true,
            calls: [
              {
                id: 'script/1',
                name: 'read',
                status: 'ok',
                arguments: { path: 'src/one.ts' },
              },
              {
                id: 'script/2',
                name: 'bash',
                status: 'ok',
                arguments: {
                  command: 'ls src',
                  description: 'Inspect source files',
                },
              },
            ],
          },
        },
      },
    );
    await installDashboardBootstrap(page, snapshot(`codemode-${project}`), {
      strictApi: true,
      sessionSnapshot: { entries },
    });
    await routeLegacySessionReads(page);
    await page.goto('/sessions/session-1');
    await page.getByRole('button', { name: /Work log.*2 actions/ }).click();
    const transcript = page.getByLabel('Transcript', { exact: true });
    const calls = transcript.locator('details.tool-detail');
    await expect(calls).toHaveCount(3);
    await expect(calls.first().locator('.tool-name')).toHaveText('Codemode');
    await expect(transcript.locator('.codemode-child-indicator')).toHaveCount(
      2,
    );
    await expect(
      calls.nth(1).locator('.codemode-child-indicator [aria-hidden]'),
    ).toHaveText('↳');
    await expect(
      calls.nth(1).locator('.codemode-child-indicator'),
    ).toHaveAttribute(
      'title',
      'Child results go to the script, not directly to the agent.',
    );
    const bashTitle = calls.nth(2).locator('.tool-name');
    await expect(bashTitle).toContainText('Inspect source files');
    await expect(bashTitle).toHaveCSS('font-style', 'italic');
    await expect(bashTitle.locator('.codemode-child-indicator')).toHaveCSS(
      'font-style',
      'normal',
    );
    await expect(
      transcript.getByText('via codemode', { exact: true }),
    ).toHaveCount(0);
    await page.screenshot({ path: `/tmp/pi-transcript-${project}.png` });
    await calls.first().locator(':scope > summary').click();
    await expect(
      calls.first().getByText('Script output', { exact: true }),
    ).toBeVisible();
    assertNoUnexpectedDashboardApiRequests(page);
  });

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
