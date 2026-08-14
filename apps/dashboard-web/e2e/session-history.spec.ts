import { expect, test } from '@playwright/test';
import {
  dashboardTrpcInput,
  installDashboardBootstrap,
} from './dashboard-fixtures';

const snapshot = {
  serverId: 'history-test',
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
};

const metadata = snapshot.sessions[0];

test('loads earlier session history on demand', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('pi-dashboard-token', 'test-token'),
  );
  await installDashboardBootstrap(page, snapshot);
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  let beforeRequest: string | undefined;
  let initialReads = 0;
  let releaseOlder!: () => void;
  const olderResponse = new Promise<void>((resolve) => {
    releaseOlder = resolve;
  });
  await page.route('**/trpc/sessionSnapshot*', async (route) => {
    const input = dashboardTrpcInput(route.request()) as {
      before?: string;
    };
    beforeRequest = input.before;
    const older = beforeRequest !== undefined;
    if (!older) initialReads += 1;
    if (older) await olderResponse;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        result: {
          data: {
            metadata,
            entries: older
              ? [
                  { type: 'session', id: 'session-1', cwd: '/tmp' },
                  {
                    type: 'message',
                    id: 'first-user',
                    message: { role: 'user', content: 'first request' },
                  },
                ]
              : [
                  ...Array.from({ length: 90 }, (_, index) => ({
                    type: 'message',
                    id: `history-${index}`,
                    message: {
                      role: 'user',
                      content: `history ${index}`,
                    },
                  })),
                  {
                    type: 'message',
                    id: 'latest',
                    message: { role: 'assistant', content: 'latest response' },
                  },
                ],
            entriesComplete: false,
            serverId: 'history-test',
            cursor: 1,
            history: older
              ? { version: 1, start: 0, end: 2, hasOlder: false }
              : {
                  version: 1,
                  start: 2,
                  end: 3,
                  hasOlder: true,
                  nextBefore: 'token-1',
                },
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
  await expect.poll(() => initialReads).toBe(1);
  await page.getByRole('button', { name: 'Load earlier history' }).click();
  await expect.poll(() => beforeRequest).toBe('token-1');
  const beforePrepend = await page
    .locator('.session-transcript-scroll')
    .evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
  releaseOlder();
  await expect
    .poll(() =>
      page
        .locator('.session-transcript-scroll')
        .evaluate((element) => element.scrollHeight),
    )
    .toBeGreaterThan(beforePrepend.scrollHeight);
  const afterPrepend = await page
    .locator('.session-transcript-scroll')
    .evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
  expect(afterPrepend.scrollHeight).toBeGreaterThan(beforePrepend.scrollHeight);
  expect(afterPrepend.scrollTop).toBeCloseTo(
    beforePrepend.scrollTop +
      (afterPrepend.scrollHeight - beforePrepend.scrollHeight),
    0,
  );
  await page.locator('.session-transcript-scroll').evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByText('first request')).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: /Load earlier history|Retry earlier history/,
    }),
  ).toHaveCount(0);
});
