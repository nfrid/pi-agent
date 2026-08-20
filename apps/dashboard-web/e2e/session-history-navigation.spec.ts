import { expect, type Page, test } from '@playwright/test';
import {
  dashboardTrpcInput,
  installDashboardBootstrap,
  trpcSseData,
} from './dashboard-fixtures';

const transcriptScroll = (page: Page) =>
  page.locator('.session-transcript-scroll');

async function transcriptGap(page: Page) {
  return transcriptScroll(page).evaluate(
    (element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

async function navigateInDashboard(page: Page, pathname: string) {
  await page.evaluate((nextPathname) => {
    window.history.pushState({}, '', nextPathname);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, pathname);
  await expect(page).toHaveURL(new RegExp(`${pathname}$`, 'u'));
}

const snapshot = {
  serverId: 'history-navigation-test',
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
    {
      id: 'session-2',
      file: '/tmp/session-2.jsonl',
      cwd: '/tmp',
      updatedAt: 2,
    },
  ],
  unread: [],
};

const entries = {
  'session-1': [
    {
      type: 'message',
      id: 'latest-1',
      message: { role: 'assistant', content: 'latest session one' },
    },
  ],
  'session-2': [
    {
      type: 'message',
      id: 'latest-2',
      message: { role: 'user', content: 'second session' },
    },
  ],
};

test('aborts older history when navigating away from a session', async ({
  page,
}) => {
  let releaseOlder!: () => void;
  let olderStarted!: () => void;
  const olderRequestStarted = new Promise<void>((resolve) => {
    olderStarted = resolve;
  });
  const olderRequestRelease = new Promise<void>((resolve) => {
    releaseOlder = resolve;
  });
  await installDashboardBootstrap(page, snapshot);
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/trpc/sessionSubscribe*', async (route) => {
    const input = dashboardTrpcInput(route.request());
    const id = input.sessionId === 'session-2' ? 'session-2' : 'session-1';
    const response = {
      metadata: snapshot.sessions[id === 'session-2' ? 1 : 0],
      entries: entries[id],
      entriesComplete: false,
      serverId: snapshot.serverId,
      cursor: 1,
      ...(id === 'session-1'
        ? {
            history: {
              version: 1,
              start: 2,
              end: 3,
              hasOlder: true,
              nextBefore: 'token-1',
            },
          }
        : {}),
      active: {
        pendingInteractions: [],
        messages: [],
        tools: [],
        delegates: [],
        truncated: false,
      },
      completeThroughCursor: false,
    };
    await route.fulfill({
      contentType: 'text/event-stream',
      body: trpcSseData(
        { type: 'snapshot', sequence: 1, snapshot: response },
        `session-feed-${id}`,
      ),
    });
  });
  await page.route('**/trpc/sessionSnapshot*', async (route) => {
    const input = dashboardTrpcInput(route.request()) as {
      sessionId?: string;
      before?: string;
    };
    const id = input.sessionId ?? '';
    const before = input.before;
    if (id === 'session-1' && before) {
      olderStarted();
      await olderRequestRelease;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          result: {
            data: {
              metadata: snapshot.sessions[0],
              entries: [
                { type: 'session', id: 'session-1', cwd: '/tmp' },
                {
                  type: 'message',
                  id: 'first-user',
                  message: { role: 'user', content: 'old session one' },
                },
              ],
              entriesComplete: false,
              serverId: snapshot.serverId,
              cursor: 1,
              history: { version: 1, start: 0, end: 2, hasOlder: false },
              active: {
                pendingInteractions: [],
                messages: [],
                tools: [],
                delegates: [],
                truncated: false,
              },
              completeThroughCursor: false,
            },
          },
        }),
      });
    }
    const session = id === 'session-2' ? 'session-2' : 'session-1';
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        result: {
          data: {
            metadata: snapshot.sessions[session === 'session-2' ? 1 : 0],
            entries: entries[session],
            entriesComplete: false,
            serverId: snapshot.serverId,
            cursor: 1,
            ...(session === 'session-1'
              ? {
                  history: {
                    version: 1,
                    start: 2,
                    end: 3,
                    hasOlder: true,
                    nextBefore: 'token-1',
                  },
                }
              : {}),
            active: {
              pendingInteractions: [],
              messages: [],
              tools: [],
              delegates: [],
              truncated: false,
            },
            completeThroughCursor: false,
          },
        },
      }),
    });
  });

  await page.goto('/sessions/session-1');
  await expect(
    page.getByRole('button', { name: 'Load earlier history' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Load earlier history' }).click();
  await olderRequestStarted;
  await page.goto('/');
  await expect(page).toHaveURL(/\/$/u);
  releaseOlder();
  await expect(page.getByText('old session one')).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: /Load earlier history|Retry earlier history/,
    }),
  ).toHaveCount(0);
});

test('switching chats establishes the new transcript tail', async ({
  page,
}) => {
  const sessions = [
    { ...snapshot.sessions[0], title: 'First chat' },
    { ...snapshot.sessions[1], title: 'Second chat' },
  ];
  const sessionEntries = (id: string) =>
    Array.from({ length: 120 }, (_, index) => ({
      type: 'message',
      id: `${id}-${index}`,
      message: {
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `${id} message ${index} ${'transcript detail '.repeat(8)}`,
      },
    }));
  await installDashboardBootstrap(page, { ...snapshot, sessions });
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  let releaseSecondSession!: () => void;
  let secondSessionStarted!: () => void;
  const secondSessionRequest = new Promise<void>((resolve) => {
    secondSessionStarted = resolve;
  });
  const secondSessionResponse = new Promise<void>((resolve) => {
    releaseSecondSession = resolve;
  });
  await page.route('**/trpc/sessionSubscribe*', async (route) => {
    const input = dashboardTrpcInput(route.request()) as {
      sessionId?: string;
    };
    const id = input.sessionId ?? '';
    const sessionIndex = id === 'session-2' ? 1 : 0;
    if (id === 'session-2') {
      secondSessionStarted();
      await secondSessionResponse;
    }
    return route.fulfill({
      contentType: 'text/event-stream',
      body: trpcSseData(
        {
          type: 'snapshot',
          sequence: 1,
          snapshot: {
            metadata: sessions[sessionIndex],
            entries: sessionEntries(id),
            entriesComplete: false,
            serverId: snapshot.serverId,
            cursor: 1,
            active: {
              pendingInteractions: [],
              messages: [],
              tools: [],
              delegates: [],
              truncated: false,
            },
            completeThroughCursor: false,
          },
        },
        `session-feed-${id}`,
      ),
    });
  });

  await page.goto('/sessions/session-1');
  await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(2);
  await transcriptScroll(page).evaluate((element) => {
    element.scrollTop = Math.min(300, element.scrollHeight);
  });
  await expect
    .poll(() => transcriptScroll(page).evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Open agent list' }).click();
  await page
    .locator('.agent-nav-drawer.open .agent-thread-row')
    .filter({ hasText: 'Second chat' })
    .click();
  await expect(page).toHaveURL(/\/sessions\/session-2$/u);
  await secondSessionRequest;
  const loadingCurtain = page.locator('.session-loading-curtain');
  await expect(page.locator('.session-page-loading')).toBeVisible();
  await expect(loadingCurtain).toBeVisible();
  await expect(page.locator('.session-transcript-loading')).toHaveCount(1);
  await expect(page.locator('[data-transcript-row]:visible')).toHaveCount(0);
  releaseSecondSession();
  await expect(loadingCurtain).toBeVisible();
  await expect(page.locator('[data-transcript-row]:visible')).toHaveCount(0);
  await expect(page.getByText(/session-2 message 119/u)).toBeVisible();
  await expect(loadingCurtain).toHaveCount(0);
  await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(2);
  await transcriptScroll(page).evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -240 }));
    element.scrollTop = Math.max(0, element.scrollTop - 240);
  });
  await expect.poll(() => transcriptGap(page)).toBeGreaterThan(120);
});

test('renders retained and persisted cached sessions immediately', async ({
  page,
}) => {
  const sessions = Array.from({ length: 4 }, (_, index) => ({
    id: `cache-session-${index + 1}`,
    file: `/tmp/cache-session-${index + 1}.jsonl`,
    cwd: '/tmp',
    title: `Cache session ${index + 1}`,
    updatedAt: index + 1,
  }));
  await installDashboardBootstrap(page, { ...snapshot, sessions });
  const requestCounts = new Map<string, number>();
  let releaseCached!: () => void;
  let cachedStarted!: () => void;
  const cachedRequest = new Promise<void>((resolve) => {
    cachedStarted = resolve;
  });
  const cachedRelease = new Promise<void>((resolve) => {
    releaseCached = resolve;
  });
  let releaseEvicted!: () => void;
  let evictedStarted!: () => void;
  const evictedRequest = new Promise<void>((resolve) => {
    evictedStarted = resolve;
  });
  const evictedRelease = new Promise<void>((resolve) => {
    releaseEvicted = resolve;
  });
  let cachedResumeCursor: unknown;
  let evictedResumeCursor: unknown;
  await page.route('**/trpc/sessionSubscribe*', async (route) => {
    const input = dashboardTrpcInput(route.request());
    const id = String(input.sessionId ?? '');
    const count = (requestCounts.get(id) ?? 0) + 1;
    requestCounts.set(id, count);
    if (id === 'cache-session-1' && count === 2) {
      cachedResumeCursor = input.lastEventId;
      cachedStarted();
      await cachedRelease;
    }
    if (id === 'cache-session-1' && count === 3) {
      evictedResumeCursor = input.lastEventId;
      evictedStarted();
      await evictedRelease;
    }
    const index = Number(id.at(-1)) - 1;
    const content =
      id === 'cache-session-1' && count === 2
        ? 'session one refreshed'
        : `session ${index + 1} cached content`;
    await route.fulfill({
      contentType: 'text/event-stream',
      body: trpcSseData(
        {
          type: 'snapshot',
          sequence: count,
          snapshot: {
            metadata: sessions[index],
            entries: [
              {
                type: 'message',
                id: `${id}-message-${count}`,
                message: { role: 'assistant', content },
              },
            ],
            entriesComplete: true,
            serverId: snapshot.serverId,
            cursor: count,
            active: {
              pendingInteractions: [],
              messages: [],
              tools: [],
              delegates: [],
              truncated: false,
            },
            completeThroughCursor: true,
          },
        },
        `${id}-feed-${count}`,
      ),
    });
  });

  await page.goto('/sessions/cache-session-1');
  await expect(page.getByText('session 1 cached content')).toBeVisible();
  await navigateInDashboard(page, '/sessions/cache-session-2');
  await expect(page.getByText('session 2 cached content')).toBeVisible();
  await navigateInDashboard(page, '/sessions/cache-session-1');
  await cachedRequest;
  await expect(page.getByText('session 1 cached content')).toBeVisible();
  await expect(page.locator('.session-loading-curtain')).toHaveCount(0);
  expect(cachedResumeCursor).toBe('cache-session-1-feed-1-caught-up');
  releaseCached();
  await expect(page.getByText('session one refreshed')).toBeVisible();
  await expect(page.getByText('session 1 cached content')).toHaveCount(0);

  for (const id of ['cache-session-2', 'cache-session-3', 'cache-session-4']) {
    await navigateInDashboard(page, `/sessions/${id}`);
    await expect(
      page.getByText(new RegExp(`${id.at(-1)} cached content`)),
    ).toBeVisible();
  }
  await navigateInDashboard(page, '/sessions/cache-session-1');
  await evictedRequest;
  // IndexedDB warm state has no opaque SSE event ID, so the feed starts with
  // a fresh authoritative snapshot while the settled transcript stays visible.
  expect(evictedResumeCursor).toBeUndefined();
  await expect(page.locator('.session-page-loading')).toHaveCount(0);
  await expect(page.getByText('session one refreshed')).toBeVisible();
  releaseEvicted();
  await expect(page.getByText('session 1 cached content')).toBeVisible();
  await expect(page.getByText('session one refreshed')).toHaveCount(0);
});

test('active to old to active ignores a delayed stale latest snapshot', async ({
  page,
}) => {
  let releaseStale!: () => void;
  let staleStarted!: () => void;
  const staleRelease = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  const staleRequest = new Promise<void>((resolve) => {
    staleStarted = resolve;
  });
  const runtime = {
    runtimeId: 'runtime-1',
    ownership: 'external',
    pid: 1,
    cwd: '/tmp',
    liveState: 'working',
    session: { id: 'session-1', entries: [], entriesComplete: false },
    pendingInteractions: [],
    online: true,
  };
  const activeSnapshot = { ...snapshot, runtimes: [runtime] };
  await installDashboardBootstrap(page, activeSnapshot);
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  let activeRequests = 0;
  await page.route('**/trpc/sessionSubscribe*', async (route) => {
    const input = dashboardTrpcInput(route.request()) as {
      sessionId?: string;
    };
    const id = input.sessionId ?? '';
    if (id === 'session-1') {
      activeRequests += 1;
      if (activeRequests === 1) {
        staleStarted();
        await staleRelease;
      }
    }
    const current = id === 'session-1' && activeRequests >= 2;
    const session = snapshot.sessions[id === 'session-2' ? 1 : 0];
    const messageId = current ? 'assistant-current' : 'assistant-stale';
    const toolId = current ? 'tool-current' : 'tool-stale';
    const delegateId = current ? 'delegate-current' : 'delegate-stale';
    return route.fulfill({
      contentType: 'text/event-stream',
      body: trpcSseData(
        {
          type: 'snapshot',
          sequence: 1,
          snapshot: {
            metadata: {
              ...session,
              ...(id === 'session-1' ? { activeRuntimeId: 'runtime-1' } : {}),
            },
            entries: id === 'session-2' ? entries['session-2'] : [],
            entriesComplete: true,
            serverId: snapshot.serverId,
            cursor: 1,
            active:
              id === 'session-1'
                ? {
                    runtimeId: 'runtime-1',
                    pendingInteractions: [],
                    messages: [
                      {
                        messageId,
                        role: 'assistant',
                        content: current ? 'partial current' : 'partial stale',
                        phase: 'updated',
                      },
                    ],
                    tools: [
                      { toolCallId: toolId, name: 'read', status: 'running' },
                    ],
                    delegates: [
                      {
                        runId: delegateId,
                        lineageId: `lineage-${delegateId}`,
                        name: 'worker',
                        kind: 'background',
                        state: 'running',
                        createdAt: 1,
                        allowWrites: false,
                        transcript: [],
                      },
                    ],
                    truncated: false,
                  }
                : {
                    pendingInteractions: [],
                    messages: [],
                    tools: [],
                    delegates: [],
                    truncated: false,
                  },
            completeThroughCursor: true,
          },
        },
        `session-feed-${id}-${activeRequests}`,
      ),
    });
  });

  await page.goto('/sessions/session-1');
  await staleRequest;
  await page.goto('/sessions/session-2');
  await expect(page).toHaveURL(/\/sessions\/session-2$/u);
  await expect(
    page.getByLabel('Transcript', { exact: true }).getByText('second session'),
  ).toBeVisible();
  await page.goto('/sessions/session-1');
  await expect.poll(() => activeRequests).toBe(2);
  await expect(page.getByText('partial current')).toHaveCount(1);
  await expect(page.getByText('partial stale')).toHaveCount(0);
  await expect(
    page.locator('[data-transcript-key="assistant-current"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-transcript-key="tool-current"]'),
  ).toHaveCount(1);

  releaseStale();
  await expect(page.getByText('partial current')).toHaveCount(1);
  await expect(page.getByText('partial stale')).toHaveCount(0);
  await expect(
    page.locator('[data-transcript-key="assistant-current"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-transcript-key="tool-current"]'),
  ).toHaveCount(1);
  await page.getByRole('button', { name: /Delegates/u }).click();
  await expect(page.locator('.delegate-row')).toHaveCount(1);
  await expect(page.locator('.delegate-row').getByText('worker')).toHaveCount(
    1,
  );
});
