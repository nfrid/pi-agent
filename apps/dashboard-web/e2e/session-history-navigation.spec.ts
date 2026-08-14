import { expect, type Page, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

const transcriptScroll = (page: Page) =>
  page.locator('.session-transcript-scroll');

async function transcriptGap(page: Page) {
  return transcriptScroll(page).evaluate(
    (element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
  );
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
  await page.route('**/trpc/sessionSnapshot*', async (route) => {
    const url = new URL(route.request().url());
    const input = JSON.parse(url.searchParams.get('input') ?? '{}') as {
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
  await page.route('**/trpc/sessionSnapshot*', async (route) => {
    const input = JSON.parse(
      new URL(route.request().url()).searchParams.get('input') ?? '{}',
    ) as { sessionId?: string };
    const id = input.sessionId ?? '';
    const sessionIndex = id === 'session-2' ? 1 : 0;
    if (id === 'session-2') {
      secondSessionStarted();
      await secondSessionResponse;
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        result: {
          data: {
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
      }),
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
