import { expect, test } from '@playwright/test';
import {
  assertNoUnexpectedDashboardApiRequests,
  dashboardTrpcInput,
  installDashboardBootstrap,
  trpcData,
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

function pagedWorkLogEntries(interiorCount = 1) {
  return [
    ...Array.from({ length: interiorCount }, (_, index) => ({
      type: 'message',
      id: `work-${index}`,
      message: {
        id: `work-${index}`,
        role: 'assistant',
        content: [{ type: 'text', text: `Work item ${index}` }],
      },
    })),
    {
      type: 'message',
      id: 'answer',
      message: {
        id: 'answer',
        role: 'assistant',
        content: [{ type: 'text', text: 'Paged work is done' }],
      },
    },
    {
      type: 'custom',
      id: 'closure',
      customType: 'response-closure',
      data: {
        requestMessageId: 'older-request',
        finalMessageId: 'answer',
        startedAt: 1000,
        endedAt: 91000,
      },
    },
  ];
}

async function installPagedWorkLog(
  page: import('@playwright/test').Page,
  options: {
    interiorCount?: number;
    gateFirstPage?: boolean;
    failFirstPage?: boolean;
  } = {},
) {
  const metadata = snapshot('work-log-paged').sessions[0];
  if (!metadata) throw new Error('Missing work-log session metadata');
  const latestEntries = pagedWorkLogEntries(options.interiorCount);
  if (options.interiorCount && options.interiorCount > 1) {
    const workFortyIndex = latestEntries.findIndex(
      (entry) => entry.id === 'work-40',
    );
    latestEntries.splice(
      workFortyIndex + 1,
      0,
      {
        type: 'message',
        id: 'steering-target',
        message: {
          id: 'steering-target',
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
  const latest = {
    metadata,
    entries: latestEntries,
    outline: [
      { id: 'older-request', ordinal: 1, kind: 'user', label: 'Old request' },
      ...(options.interiorCount && options.interiorCount > 1
        ? [
            {
              id: 'steering-target',
              ordinal: 49,
              kind: 'user',
              deliveryMode: 'steer',
              label: 'Redirect this step',
            },
          ]
        : []),
    ],
    history: {
      version: 1,
      start: 8,
      end:
        10 +
        (options.interiorCount ?? 1) +
        (options.interiorCount && options.interiorCount > 1 ? 2 : 0),
      hasOlder: true,
      nextBefore: 'older-8',
    },
    entriesComplete: false,
    serverId: 'work-log-paged',
    cursor: 1,
    active: { messages: [], tools: [], delegates: [], truncated: false },
    completeThroughCursor: true,
  };
  await installDashboardBootstrap(page, snapshot('work-log-paged'), {
    strictApi: true,
    sessionSnapshot: latest,
  });
  await routeLegacySessionReads(page);
  let markFirstPageRequested!: () => void;
  const firstPageRequested = new Promise<void>((resolve) => {
    markFirstPageRequested = resolve;
  });
  let releaseFirstPage!: () => void;
  const firstPageGate = new Promise<void>((resolve) => {
    releaseFirstPage = resolve;
  });
  await page.route('**/trpc/sessionSnapshot*', async (route) => {
    const input = dashboardTrpcInput(route.request());
    const before = input.before;
    if (before === 'older-8') {
      markFirstPageRequested();
      if (options.failFirstPage) {
        await route.abort('failed');
        return;
      }
      if (options.gateFirstPage) await firstPageGate;
      await route.fulfill({
        contentType: 'application/json',
        body: trpcData({
          ...latest,
          entries: Array.from({ length: 4 }, (_, index) => ({
            type: 'message',
            id: `older-${index + 4}`,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `Older item ${index + 4}` }],
            },
          })),
          history: {
            version: 1,
            start: 4,
            end: 8,
            hasOlder: true,
            nextBefore: 'older-4',
          },
        }),
      });
      return;
    }
    if (before === 'older-4') {
      await route.fulfill({
        contentType: 'application/json',
        body: trpcData({
          ...latest,
          entries: [
            { type: 'session', id: 'session-1', cwd: '/tmp' },
            {
              type: 'message',
              id: 'older-request',
              message: {
                role: 'user',
                content: [{ type: 'text', text: 'Old request' }],
              },
            },
            {
              type: 'message',
              id: 'older-work-1',
              message: { role: 'assistant', content: 'Older work 1' },
            },
            {
              type: 'message',
              id: 'older-work-2',
              message: { role: 'assistant', content: 'Older work 2' },
            },
          ],
          history: { version: 1, start: 0, end: 4, hasOlder: false },
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: trpcData(latest),
    });
  });
  return { firstPageRequested, releaseFirstPage };
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

test('an incomplete work log fetches only through its request when opened', async ({
  page,
}) => {
  await installPagedWorkLog(page);
  const cursors: string[] = [];
  await page.route('**/trpc/sessionSnapshot*', async (route) => {
    const input = dashboardTrpcInput(route.request());
    if (typeof input.before === 'string') cursors.push(input.before);
    await route.fallback();
  });
  await page.goto('/sessions/session-1');
  const transcript = page.getByLabel('Transcript', { exact: true });
  const workLog = transcript.getByRole('button', { name: /Work log/ });
  await expect(workLog).toBeVisible();
  await expect(workLog).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Work item 0', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Paged work is done')).toBeVisible();
  await workLog.click();
  await expect(workLog).toHaveAttribute('aria-expanded', 'true');
  await expect(
    transcript.locator('[data-transcript-key="older-request"]'),
  ).toBeVisible();
  await expect(page.getByText('Work item 0', { exact: true })).toBeVisible();
  await expect(page.getByText('Paged work is done')).toBeVisible();
  expect(cursors).toEqual(['older-8', 'older-4']);
  assertNoUnexpectedDashboardApiRequests(page);
});

test('closing a partial work log during history loading prevents a late open', async ({
  page,
}) => {
  const { firstPageRequested, releaseFirstPage } = await installPagedWorkLog(
    page,
    { gateFirstPage: true },
  );
  await page.goto('/sessions/session-1');
  const workLog = page
    .getByLabel('Transcript', { exact: true })
    .getByRole('button', { name: /Work log/ });
  await expect(workLog).toBeVisible();
  await workLog.click();
  await firstPageRequested;
  await expect(workLog).toHaveAttribute('aria-busy', 'true');
  await workLog.click();
  await expect(workLog).toHaveAttribute('aria-expanded', 'false');
  releaseFirstPage();
  await expect(
    page
      .getByLabel('Transcript', { exact: true })
      .locator('[data-transcript-key="older-request"]'),
  ).toBeVisible();
  await expect(page.getByText('Work item 0', { exact: true })).toHaveCount(0);
  await expect(workLog).toHaveAttribute('aria-expanded', 'false');
  assertNoUnexpectedDashboardApiRequests(page);
});

test('a failed partial work-log load clears its pending disclosure state', async ({
  page,
}) => {
  const { firstPageRequested } = await installPagedWorkLog(page, {
    failFirstPage: true,
  });
  await page.goto('/sessions/session-1');
  const workLog = page
    .getByLabel('Transcript', { exact: true })
    .getByRole('button', { name: /Work log/ });
  await expect(workLog).toBeVisible();
  await workLog.click();
  await firstPageRequested;
  await expect(workLog).not.toHaveAttribute('aria-busy', 'true');
  await expect(workLog).toHaveAttribute('aria-expanded', 'false');
  assertNoUnexpectedDashboardApiRequests(page);
});

test('virtualized outline jumps open a partial work log and land on the target @desktop', async ({
  page,
}) => {
  await installPagedWorkLog(page, { interiorCount: 88 });
  await page.goto('/sessions/session-1');
  const transcript = page.getByLabel('Transcript', { exact: true });
  const landmark = page
    .getByLabel('Transcript turn map')
    .getByRole('button', { name: /Redirect this step/ });
  await expect(landmark).toBeVisible();
  await landmark.click();
  const target = transcript.locator('[data-transcript-key="steering-target"]');
  await expect(target).toBeInViewport();
  assertNoUnexpectedDashboardApiRequests(page);
});

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
