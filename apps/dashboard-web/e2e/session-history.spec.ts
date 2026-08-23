import { expect, type Page, test } from '@playwright/test';
import {
  dashboardTrpcInput,
  installDashboardBootstrap,
  trpcSseData,
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

async function verifyEarlierHistoryAnchor(
  page: Page,
  options: { jumpFromOutline?: boolean; entryCount?: number } = {},
) {
  const entryCount = options.entryCount ?? 90;
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
  await page.route('**/trpc/sessionSubscribe*', async (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: trpcSseData(
        {
          type: 'snapshot',
          sequence: 1,
          snapshot: {
            metadata,
            entries: [
              ...Array.from({ length: entryCount }, (_, index) => ({
                type: 'message',
                id: `history-${index}`,
                message: { role: 'user', content: `history ${index}` },
              })),
              {
                type: 'message',
                id: 'latest',
                message: { role: 'assistant', content: 'latest response' },
              },
            ],
            outline: [
              {
                id: 'first-user',
                ordinal: 1,
                kind: 'user',
                label: 'first request',
              },
              {
                id: 'latest',
                ordinal: 2,
                kind: 'assistant',
                label: 'latest response',
              },
            ],
            entriesComplete: false,
            serverId: 'history-test',
            cursor: 1,
            history: {
              version: 1,
              start: 2,
              end: 3,
              hasOlder: true,
              nextBefore: 'token-1',
            },
            active: {
              messages: [],
              tools: [],
              delegates: [],
              truncated: false,
            },
            completeThroughCursor: false,
          },
        },
        'session-feed-1',
      ),
    }),
  );
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
                  ...Array.from({ length: entryCount }, (_, index) => ({
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
            outline: [
              {
                id: 'first-user',
                ordinal: 1,
                kind: 'user',
                label: 'first request',
              },
              {
                id: 'latest',
                ordinal: 2,
                kind: 'assistant',
                label: 'latest response',
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
  ).toHaveCount(0);
  // The selected feed supplies the initial baseline; only the older page is finite.
  await expect.poll(() => initialReads).toBe(0);
  if (options.jumpFromOutline) {
    await page.getByRole('button', { name: 'Open transcript outline' }).click();
    const outline = page.getByRole('dialog', { name: 'Transcript outline' });
    await expect(
      outline.getByRole('button', { name: /first request/i }),
    ).toBeVisible();
    await outline.getByRole('button', { name: /first request/i }).click();
  } else {
    await page.locator('.session-transcript-scroll').evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
  }
  await expect.poll(() => beforeRequest).toBe('token-1');
  const beforePrepend = await page
    .locator('.session-transcript-scroll')
    .evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      const visible = Array.from(
        element.querySelectorAll<HTMLElement>(
          '[data-transcript-row], [data-transcript-key]',
        ),
      ).find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom >= viewport.top && rect.top <= viewport.bottom;
      });
      return {
        scrollHeight: element.scrollHeight,
        key:
          visible?.dataset.transcriptRow ??
          visible?.dataset.transcriptKey ??
          '',
        offset: visible
          ? visible.getBoundingClientRect().top - viewport.top
          : Number.NaN,
      };
    });
  expect(beforePrepend.key).not.toBe('');
  // Real trackpads keep emitting upward inertia after reaching scrollTop 0.
  // Those events must not cancel the anchor captured for this same prepend.
  await page.locator('.session-transcript-scroll').evaluate((element) => {
    for (let index = 0; index < 3; index += 1)
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    // A touch/pointer gesture can span response completion. Restoration waits
    // for release so its own scroll write cannot be mistaken for user motion.
    element.dispatchEvent(new PointerEvent('pointerdown'));
  });
  releaseOlder();
  await expect
    .poll(() =>
      page
        .locator('.session-transcript-scroll')
        .evaluate((element) => element.scrollHeight),
    )
    .toBeGreaterThan(beforePrepend.scrollHeight);
  await page.evaluate(() =>
    window.dispatchEvent(new PointerEvent('pointerup')),
  );
  if (options.jumpFromOutline) {
    await expect(
      page
        .getByRole('region', { name: 'Transcript', exact: true })
        .getByText('first request', { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.locator('.session-transcript-scroll').evaluate((element) => {
          const target = Array.from(
            element.querySelectorAll<HTMLElement>('[data-transcript-key]'),
          ).find(
            (candidate) => candidate.dataset.transcriptKey === 'first-user',
          );
          return target
            ? Math.abs(
                target.getBoundingClientRect().top -
                  element.getBoundingClientRect().top,
              )
            : Number.POSITIVE_INFINITY;
        }),
      )
      .toBeLessThan(32);
    return;
  }
  await expect
    .poll(() =>
      page.locator('.session-transcript-scroll').evaluate((element, key) => {
        const target = Array.from(
          element.querySelectorAll<HTMLElement>(
            '[data-transcript-row], [data-transcript-key]',
          ),
        ).find(
          (candidate) =>
            (candidate.dataset.transcriptRow ??
              candidate.dataset.transcriptKey) === key,
        );
        return target
          ? target.getBoundingClientRect().top -
              element.getBoundingClientRect().top
          : Number.NaN;
      }, beforePrepend.key),
    )
    .toBeCloseTo(beforePrepend.offset, 0);
  await page.locator('.session-transcript-scroll').evaluate((element) => {
    const nextTop = Math.max(0, element.scrollTop - 48);
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -48 }));
    element.scrollTop = nextTop;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(500);
  expect(beforeRequest).toBe('token-1');
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
}

test('loads earlier session history with a stable virtual anchor', async ({
  page,
}) => {
  await verifyEarlierHistoryAnchor(page);
});

test('loads and jumps to an unloaded outline landmark @desktop', async ({
  page,
}) => {
  await verifyEarlierHistoryAnchor(page, { jumpFromOutline: true });
});

test('loads an unloaded outline landmark in the regular transcript', async ({
  page,
}) => {
  await verifyEarlierHistoryAnchor(page, {
    jumpFromOutline: true,
    entryCount: 70,
  });
});
