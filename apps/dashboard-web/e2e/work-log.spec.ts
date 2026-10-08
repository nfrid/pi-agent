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
    markedEarlierAnswer?: boolean;
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
          entries: Array.from({ length: 4 }, (_, index) =>
            options.markedEarlierAnswer && index === 2
              ? {
                  type: 'message',
                  id: 'older-answer',
                  message: {
                    role: 'assistant',
                    content: [
                      {
                        type: 'text',
                        text: 'Earlier marked answer',
                        textSignature: JSON.stringify({
                          v: 1,
                          id: 'earlier',
                          phase: 'final_answer',
                        }),
                      },
                    ],
                  },
                }
              : {
                  type: 'message',
                  id: `older-${index + 4}`,
                  message: {
                    role: 'assistant',
                    content: [
                      { type: 'text', text: `Older item ${index + 4}` },
                    ],
                  },
                },
          ),
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

function stickyWorkLogEntries(
  interiorCount: number,
  options: { tallFollowingContent?: boolean; tallToolOutput?: boolean } = {},
) {
  const laterText = options.tallFollowingContent
    ? Array.from({ length: 24 }, (_, index) =>
        index === 0
          ? 'Later content after the work log'
          : `Later content paragraph ${index}`,
      ).join('\n\n')
    : 'Later content after the work log';
  const entries: unknown[] = [
    {
      type: 'message',
      id: 'request',
      message: {
        id: 'request',
        role: 'user',
        content: [{ type: 'text', text: 'Inspect the long task' }],
      },
    },
  ];
  const toolCount = options.tallToolOutput ? 24 : 8;
  for (let index = 0; index < toolCount; index += 1) {
    entries.push(
      {
        type: 'message',
        id: `call-${index}`,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: `read-${index}`,
              name: 'read',
              arguments: { path: `src/file-${index}.ts` },
            },
          ],
        },
      },
      {
        type: 'message',
        id: `result-${index}`,
        message: {
          role: 'toolResult',
          toolCallId: `read-${index}`,
          toolName: 'read',
          isError: false,
          content: [
            {
              type: 'text',
              text:
                options.tallToolOutput && index === 0
                  ? Array.from(
                      { length: 80 },
                      (_, paragraph) =>
                        `Large tool output paragraph ${paragraph}`,
                    ).join('\n\n')
                  : `Read file ${index}`,
            },
          ],
        },
      },
    );
  }
  for (let index = 0; index < interiorCount; index += 1)
    entries.push({
      type: 'message',
      id: `work-${index}`,
      message: {
        id: `work-${index}`,
        role: 'assistant',
        content: [{ type: 'text', text: `Work step ${index}` }],
      },
    });
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
    {
      type: 'message',
      id: 'later-request',
      message: {
        id: 'later-request',
        role: 'user',
        content: [{ type: 'text', text: 'Start the next request' }],
      },
    },
    {
      type: 'message',
      id: 'later-content',
      message: {
        id: 'later-content',
        role: 'assistant',
        content: [{ type: 'text', text: laterText }],
      },
    },
  );
  return entries;
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
  const workLog = transcript.getByRole('button', { name: /Worked for/ });
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

test('a partial work log retains a marked answer after its history page is prepended', async ({
  page,
}) => {
  await installPagedWorkLog(page, { markedEarlierAnswer: true });
  await page.goto('/sessions/session-1');
  const transcript = page.getByLabel('Transcript', { exact: true });
  const workLog = transcript.getByRole('button', { name: /Worked for/ });
  await expect(workLog).toBeVisible();
  await workLog.click();
  await expect(
    transcript.getByText('Earlier marked answer', { exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText('Older item 4', { exact: true }),
  ).toBeVisible();
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
    .getByRole('button', { name: /Worked for/ });
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
    .getByRole('button', { name: /Worked for/ });
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
  const workLog = page.getByRole('button', { name: /Worked for/ });
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
  test(`expanded work-log headers stack and release at the history end on ${project}${project === 'desktop' ? ' @desktop' : ''}`, async ({
    page,
  }) => {
    await installDashboardBootstrap(
      page,
      snapshot(`sticky-work-log-${project}`),
      {
        strictApi: true,
        sessionSnapshot: {
          entries: stickyWorkLogEntries(22, { tallFollowingContent: true }),
        },
      },
    );
    await routeLegacySessionReads(page);
    if (project === 'mobile')
      await page.setViewportSize({ width: 190, height: 760 });
    await page.goto('/sessions/session-1');
    const transcript = page.getByLabel('Transcript', { exact: true });
    const viewport = page.locator('.session-transcript-scroll');
    const workLog = transcript.getByRole('button', { name: /Worked for/ });
    await expect(workLog).toHaveCount(1);
    await workLog.click();
    const activityToggle = transcript.getByRole('button', {
      name: /Show all activity/,
    });
    await expect(activityToggle).toBeVisible();
    await activityToggle.click();
    const toolDetails = transcript.locator('details.tool-detail');
    await expect(toolDetails).toHaveCount(8);
    await toolDetails.last().scrollIntoViewIfNeeded();
    await viewport.evaluate((element) => {
      element.scrollTop += 120;
    });
    const workLogHeader = transcript.locator('.transcript-work-log');
    await expect
      .poll(async () => {
        const [header, scrollport] = await Promise.all([
          workLogHeader.boundingBox(),
          viewport.boundingBox(),
        ]);
        return header && scrollport ? Math.abs(header.y - scrollport.y) : 1000;
      })
      .toBeLessThan(2);
    const stacked = await page.evaluate(() => {
      const work = document.querySelector('.transcript-work-log');
      const activity = document.querySelector('.tool-stream-meta');
      if (!work || !activity) return false;
      return (
        activity.getBoundingClientRect().top >=
        work.getBoundingClientRect().bottom - 1
      );
    });
    expect(stacked).toBe(true);
    if (project === 'mobile') {
      const headerHeight = await workLogHeader.evaluate(
        (element) => element.getBoundingClientRect().height,
      );
      expect(headerHeight).toBeGreaterThan(28);
    }
    const historyScope = transcript.locator('.transcript-work-log-scope');
    const laterContent = transcript.locator(
      '[data-transcript-key="later-content"]',
    );
    const [scopeBox, scrollportBox] = await Promise.all([
      historyScope.boundingBox(),
      viewport.boundingBox(),
    ]);
    if (!scopeBox || !scrollportBox)
      throw new Error('Missing work-log scope or transcript scrollport');
    await viewport.evaluate(
      (element, scrollDistance) => {
        element.scrollTop += scrollDistance;
      },
      scopeBox.y + scopeBox.height - scrollportBox.y + 4,
    );
    await expect(laterContent).toBeVisible();
    await expect
      .poll(async () => {
        const [scope, header, later, scrollport] = await Promise.all([
          historyScope.boundingBox(),
          workLogHeader.boundingBox(),
          laterContent.boundingBox(),
          viewport.boundingBox(),
        ]);
        return Boolean(
          scope &&
            later &&
            scrollport &&
            scope.y + scope.height <= scrollport.y + 1 &&
            (!header ||
              (header.y + header.height <= scrollport.y + 1 &&
                (header.y + header.height <= later.y ||
                  header.y >= later.y + later.height))),
        );
      })
      .toBe(true);
    await expect(workLog).toHaveCount(1);
    assertNoUnexpectedDashboardApiRequests(page);
  });

  test(`collapsing a pinned work log preserves its visible header anchor on ${project}${project === 'desktop' ? ' @desktop' : ''}`, async ({
    page,
  }) => {
    const virtualized = project === 'desktop';
    await installDashboardBootstrap(
      page,
      snapshot(`sticky-collapse-${project}`),
      {
        strictApi: true,
        sessionSnapshot: {
          entries: stickyWorkLogEntries(virtualized ? 92 : 22),
        },
      },
    );
    await routeLegacySessionReads(page);
    if (project === 'mobile')
      await page.setViewportSize({ width: 190, height: 760 });
    await page.goto('/sessions/session-1');
    const transcript = page.getByLabel('Transcript', { exact: true });
    const viewport = page.locator('.session-transcript-scroll');
    const workLog = transcript.getByRole('button', { name: /Worked for/ });
    await workLog.click();
    if (virtualized) {
      await viewport.evaluate((element) => {
        element.scrollTop = element.scrollHeight * 0.45;
      });
      await expect(transcript.getByText('Work step 45')).toBeVisible();
    } else {
      await transcript.getByText('Work step 15').scrollIntoViewIfNeeded();
      await viewport.evaluate((element) => {
        element.scrollTop += 120;
      });
    }
    const header = transcript.locator('.transcript-work-log');
    const finalAnswer = transcript.getByText('Long task complete', {
      exact: true,
    });
    await expect(header).toBeInViewport();
    await workLog.click();
    await expect(workLog).toHaveAttribute('aria-expanded', 'false');
    await expect(header).toBeInViewport();
    await expect(finalAnswer).toBeInViewport();
    assertNoUnexpectedDashboardApiRequests(page);
  });

  test(`virtualized work-log headers stay pinned near the short tail on ${project}${project === 'desktop' ? ' @desktop' : ''}`, async ({
    page,
  }) => {
    await installDashboardBootstrap(
      page,
      snapshot(`sticky-work-log-virtual-${project}`),
      {
        strictApi: true,
        sessionSnapshot: {
          entries: stickyWorkLogEntries(92, { tallToolOutput: true }),
        },
      },
    );
    await routeLegacySessionReads(page);
    if (project === 'mobile')
      await page.setViewportSize({ width: 190, height: 760 });
    await page.goto('/sessions/session-1');
    const transcript = page.getByLabel('Transcript', { exact: true });
    const viewport = page.locator('.session-transcript-scroll');
    const workLog = transcript.getByRole('button', { name: /Worked for/ });
    await expect(workLog).toHaveCount(1);
    await workLog.click();
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    const workLogHeader = transcript.locator('.transcript-work-log');
    await expect(
      transcript.locator('.transcript-virtual-work-log-header'),
    ).toHaveCount(1);
    if (project === 'desktop')
      await page
        .getByLabel('Transcript turn map')
        .getByRole('button', { name: 'Inspect the long task', exact: true })
        .click();
    const activityToggle = transcript.getByRole('button', {
      name: /Show all activity/,
    });
    await expect(activityToggle).toBeVisible();
    await activityToggle.click();
    const toolDetails = transcript.locator('details.tool-detail');
    await expect(toolDetails).toHaveCount(24);
    const activityHeader = transcript.locator('.tool-stream-meta');
    await toolDetails.first().locator(':scope > summary').click();
    const toolOutput = toolDetails
      .first()
      .locator('.tool-inspector pre')
      .first();
    await expect(toolOutput).toBeVisible();
    await toolOutput.scrollIntoViewIfNeeded();
    await toolOutput.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await viewport.evaluate((element) => {
      const header = element.querySelector('.transcript-work-log');
      if (header)
        element.scrollTop +=
          Math.max(
            0,
            header.getBoundingClientRect().top -
              element.getBoundingClientRect().top,
          ) + 100;
    });
    await expect
      .poll(async () => {
        const [header, scrollport] = await Promise.all([
          workLogHeader.boundingBox(),
          viewport.boundingBox(),
        ]);
        return header && scrollport ? Math.abs(header.y - scrollport.y) : 1000;
      })
      .toBeLessThan(2);
    const [outputBox, wheelScrollport] = await Promise.all([
      toolOutput.boundingBox(),
      viewport.boundingBox(),
    ]);
    if (!outputBox || !wheelScrollport)
      throw new Error('Missing expanded tool output');
    const toolRowIndex = await toolOutput.evaluate(
      (element) => element.closest<HTMLElement>('[data-index]')?.dataset.index,
    );
    if (toolRowIndex === undefined)
      throw new Error('Missing virtualized tool-stream row');
    await page.mouse.move(
      outputBox.x + 8,
      Math.max(outputBox.y + 12, wheelScrollport.y + 150),
    );
    const scrollTopBeforeWheel = await viewport.evaluate(
      (element) => element.scrollTop,
    );
    for (let tick = 0; tick < 6; tick += 1) {
      const beforeTick = await viewport.evaluate(
        (element) => element.scrollTop,
      );
      await page.mouse.wheel(0, 70);
      await expect
        .poll(() => viewport.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(beforeTick);
      const [header, scrollport, currentRowIndex] = await Promise.all([
        workLogHeader.boundingBox(),
        viewport.boundingBox(),
        toolOutput.evaluate(
          (element) =>
            element.closest<HTMLElement>('[data-index]')?.dataset.index,
        ),
      ]);
      expect(currentRowIndex).toBe(toolRowIndex);
      expect(
        header && scrollport ? Math.abs(header.y - scrollport.y) : 1000,
      ).toBeLessThan(2);
    }
    expect(
      await viewport.evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(scrollTopBeforeWheel + 100);
    await toolDetails.last().scrollIntoViewIfNeeded();
    await viewport.evaluate((element) => {
      element.scrollTop += 120;
    });
    await expect
      .poll(async () => {
        const [header, work] = await Promise.all([
          activityHeader.boundingBox(),
          workLogHeader.boundingBox(),
        ]);
        return header && work ? header.y >= work.y + work.height - 1 : false;
      })
      .toBe(true);
    await expect(workLog).toHaveCount(1);
    if (project === 'mobile') {
      const headerHeight = await workLogHeader.evaluate(
        (element) => element.getBoundingClientRect().height,
      );
      expect(headerHeight).toBeGreaterThan(28);
    }
    const lateWork = transcript.getByText('Work step 90', { exact: true });
    const finalAnswer = transcript.getByText('Long task complete', {
      exact: true,
    });
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(finalAnswer).toBeInViewport();
    const [answerBox, scrollportBox] = await Promise.all([
      finalAnswer.boundingBox(),
      viewport.boundingBox(),
    ]);
    if (!answerBox || !scrollportBox)
      throw new Error('Missing final answer or transcript scrollport');
    await viewport.evaluate(
      (element, delta) => {
        element.scrollTop += delta;
      },
      answerBox.y - (scrollportBox.y + scrollportBox.height * 0.68),
    );
    const lastHistoryRow = transcript.locator(
      '.transcript-virtual-row[data-transcript-row="work-91"]',
    );
    await expect(lastHistoryRow).toBeInViewport();
    await expect(lateWork).toBeInViewport();
    await expect(finalAnswer).toBeInViewport();
    await expect
      .poll(async () => {
        const [header, answer, scrollport] = await Promise.all([
          workLogHeader.boundingBox(),
          finalAnswer.boundingBox(),
          viewport.boundingBox(),
        ]);
        return Boolean(
          header &&
            answer &&
            scrollport &&
            Math.abs(header.y - scrollport.y) < 2 &&
            answer.y >= header.y + header.height,
        );
      })
      .toBe(true);
    assertNoUnexpectedDashboardApiRequests(page);
  });

  test(`virtualized work-log headers release after a tall following row on ${project}${project === 'desktop' ? ' @desktop' : ''}`, async ({
    page,
  }) => {
    await installDashboardBootstrap(
      page,
      snapshot(`sticky-work-log-release-${project}`),
      {
        strictApi: true,
        sessionSnapshot: {
          entries: stickyWorkLogEntries(92, { tallFollowingContent: true }),
        },
      },
    );
    await routeLegacySessionReads(page);
    if (project === 'mobile')
      await page.setViewportSize({ width: 190, height: 760 });
    await page.goto('/sessions/session-1');
    const transcript = page.getByLabel('Transcript', { exact: true });
    const viewport = page.locator('.session-transcript-scroll');
    const workLog = transcript.getByRole('button', { name: /Worked for/ });
    await expect(workLog).toHaveCount(1);
    await workLog.click();
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    const lastHistoryRow = transcript.locator(
      '.transcript-virtual-row[data-transcript-row="work-91"]',
    );
    for (let step = 0; step < 40; step += 1) {
      if (await lastHistoryRow.count()) break;
      await viewport.evaluate((element) => {
        element.scrollTop += element.clientHeight / 2;
      });
    }
    await lastHistoryRow.scrollIntoViewIfNeeded();
    await expect(lastHistoryRow).toBeInViewport();
    const historyBounds = transcript.locator(
      '.transcript-virtual-work-log-bounds',
    );
    const [boundsBox, scrollportBox, historyBox, oldScrollTop] =
      await Promise.all([
        historyBounds.boundingBox(),
        viewport.boundingBox(),
        lastHistoryRow.boundingBox(),
        viewport.evaluate((element) => element.scrollTop),
      ]);
    if (!boundsBox || !scrollportBox || !historyBox)
      throw new Error('Missing measured work-log history bounds');
    expect(historyBox.y + historyBox.height).toBeGreaterThan(scrollportBox.y);
    const scrollDistance = boundsBox.y + boundsBox.height - scrollportBox.y + 4;
    await viewport.evaluate((element, distance) => {
      element.scrollTop += distance;
    }, scrollDistance);
    expect(
      await viewport.evaluate((element) => element.scrollTop),
    ).toBeGreaterThanOrEqual(oldScrollTop + scrollDistance - 2);
    const laterContent = transcript.locator(
      '[data-transcript-key="later-content"]',
    );
    await expect(laterContent).toBeVisible();
    await expect
      .poll(async () => {
        return viewport.evaluate((element) => {
          const header = element
            .querySelector('.transcript-work-log')
            ?.getBoundingClientRect();
          const later = element
            .querySelector('[data-transcript-key="later-content"]')
            ?.getBoundingClientRect();
          const scrollport = element.getBoundingClientRect();
          return Boolean(
            later &&
              (!header ||
                (Math.abs(header.top - scrollport.top) > 2 &&
                  (header.bottom <= scrollport.top + 1 ||
                    header.top >= later.bottom))),
          );
        });
      })
      .toBe(true);
    assertNoUnexpectedDashboardApiRequests(page);
  });

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
    await page.getByRole('button', { name: /Worked for.*2 actions/ }).click();
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

  test(`response phases preserve answers outside collapsed work on ${project}${project === 'desktop' ? ' @desktop' : ''}`, async ({
    page,
  }) => {
    const signature = (id: string, phase: 'commentary' | 'final_answer') =>
      JSON.stringify({ v: 1, id, phase });
    const entries = [
      {
        type: 'message',
        id: 'request',
        message: { id: 'request', role: 'user', content: 'Inspect this' },
      },
      {
        type: 'message',
        id: 'progress',
        message: {
          id: 'progress',
          role: 'assistant',
          content: 'Hidden progress',
        },
      },
      {
        type: 'message',
        id: 'main',
        message: {
          id: 'main',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Private answer thought' },
            { type: 'toolCall', id: 'call', name: 'read' },
            {
              type: 'text',
              text: 'Main answer',
              textSignature: signature('main', 'final_answer'),
            },
          ],
        },
      },
      {
        type: 'tool',
        id: 'tool',
        tool: {
          toolCallId: 'call',
          name: 'read',
          arguments: {},
          result: 'Hidden tool result',
          status: 'completed',
        },
      },
      {
        type: 'message',
        id: 'addendum',
        message: {
          id: 'addendum',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Hidden commentary',
              textSignature: signature('commentary', 'commentary'),
            },
            {
              type: 'text',
              text: 'Later answer',
              textSignature: signature('later', 'final_answer'),
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'closure-final',
        message: {
          id: 'closure-final',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Closure commentary',
              textSignature: signature('closure', 'commentary'),
            },
          ],
        },
      },
      {
        type: 'custom',
        id: 'closure',
        customType: 'response-closure',
        data: {
          requestMessageId: 'request',
          finalMessageId: 'closure-final',
          startedAt: 1000,
          endedAt: 91000,
        },
      },
    ];
    await installDashboardBootstrap(
      page,
      snapshot(`work-log-phases-${project}`),
      {
        strictApi: true,
        sessionSnapshot: { entries },
      },
    );
    await routeLegacySessionReads(page);
    await page.goto('/sessions/session-1');
    const transcript = page.getByLabel('Transcript', { exact: true });
    await expect(
      transcript.getByText('Main answer', { exact: true }),
    ).toBeVisible();
    await expect(
      transcript.getByText('Later answer', { exact: true }),
    ).toBeVisible();
    for (const hidden of [
      'Hidden progress',
      'Hidden tool result',
      'Hidden commentary',
      'Closure commentary',
      'Private answer thought',
    ])
      await expect(transcript.getByText(hidden, { exact: true })).toHaveCount(
        0,
      );
    const workLog = transcript.getByRole('button', { name: /Worked for/ });
    await workLog.click();
    const text = await transcript
      .locator('.message-assistant')
      .allTextContents();
    expect(text.join(' ')).toContain('Hidden progress');
    expect(text.join(' ')).toContain('Hidden commentary');
    expect(text.join(' ')).toContain('Closure commentary');
    expect(text.join(' ')).toContain('Main answer');
    await expect(
      transcript.getByText('Private answer thought', { exact: true }),
    ).toBeVisible();
    expect(text.join(' ')).toContain('Later answer');
    assertNoUnexpectedDashboardApiRequests(page);
  });

  test(`virtualized work logs retain every marked answer on ${project}${project === 'desktop' ? ' @desktop' : ''}`, async ({
    page,
  }) => {
    const phase = (id: string) =>
      JSON.stringify({ v: 1, id, phase: 'final_answer' });
    const entries = [
      {
        type: 'message',
        id: 'request',
        message: { id: 'request', role: 'user', content: 'Inspect this' },
      },
      ...Array.from({ length: 82 }, (_, index) => ({
        type: 'message',
        id: `progress-${index}`,
        message: {
          id: `progress-${index}`,
          role: 'assistant',
          content: `Progress ${index}`,
        },
      })),
      {
        type: 'message',
        id: 'main',
        message: {
          id: 'main',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Virtual main answer',
              textSignature: phase('main'),
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'later',
        message: {
          id: 'later',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Virtual later answer',
              textSignature: phase('later'),
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'closure-final',
        message: {
          id: 'closure-final',
          role: 'assistant',
          content: 'Closure complete',
        },
      },
      {
        type: 'custom',
        id: 'closure',
        customType: 'response-closure',
        data: {
          requestMessageId: 'request',
          finalMessageId: 'closure-final',
          startedAt: 1000,
          endedAt: 91000,
        },
      },
    ];
    await installDashboardBootstrap(
      page,
      snapshot(`work-log-virtual-phases-${project}`),
      {
        strictApi: true,
        sessionSnapshot: { entries },
      },
    );
    await routeLegacySessionReads(page);
    await page.goto('/sessions/session-1');
    const transcript = page.getByLabel('Transcript', { exact: true });
    await expect(
      transcript.getByText('Virtual main answer', { exact: true }),
    ).toBeVisible();
    await expect(
      transcript.getByText('Virtual later answer', { exact: true }),
    ).toBeVisible();
    await expect(
      transcript.getByText('Progress 10', { exact: true }),
    ).toHaveCount(0);
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
    const workLog = page.getByRole('button', { name: /Worked for.*1m 30s/ });
    await expect(workLog).toBeVisible();
    await workLog.click();
    await expect(transcript.getByText('Working now')).toBeVisible();
    assertNoUnexpectedDashboardApiRequests(page);
  });
}
