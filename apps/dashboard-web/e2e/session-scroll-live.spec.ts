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

function sessionEntries(sessionId: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'message',
    id: `${sessionId}-row-${index}`,
    message: {
      id: `${sessionId}-row-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      timestamp: index + 1,
      content: [
        {
          type: 'text',
          text: `${sessionId} transcript row ${index + 1}`,
        },
      ],
    },
  }));
}

async function installLiveSessionMock(
  page: Page,
  snapshot: {
    serverId: string;
    revision: number;
    cursor: number;
    runtimes: unknown[];
    workspaces: unknown[];
    sessions: Array<Record<string, unknown>>;
    unread: unknown[];
  },
  entries: Record<string, unknown[]>,
) {
  await page.addInitScript(
    (initial: {
      snapshot: {
        serverId: string;
        cursor: number;
        sessions: Array<Record<string, unknown>>;
      };
      entries: Record<string, unknown[]>;
    }) => {
      localStorage.setItem('pi-dashboard-token', 'test-token');
      type Stream = {
        controller?: ReadableStreamDefaultController<Uint8Array>;
        close(): void;
        sendEvent(event: Record<string, unknown>): void;
      };

      const streams = new Map<string, Stream[]>();
      const sequences = new Map<string, number>();
      let messageNumber = 0;
      const encoder = new TextEncoder();
      const originalFetch = window.fetch.bind(window);
      const trackedFrame = (id: string, value: unknown) =>
        `id: ${id}\ndata: ${JSON.stringify(value)}\n\n`;
      const nextSequence = (sessionId: string) => {
        const sequence = (sequences.get(sessionId) ?? 0) + 1;
        sequences.set(sessionId, sequence);
        return sequence;
      };
      const enqueue = (
        stream: Stream,
        id: string,
        value: Record<string, unknown>,
      ) => {
        try {
          stream.controller?.enqueue(encoder.encode(trackedFrame(id, value)));
        } catch {
          // A navigated-away subscription can be cancelled by the client.
        }
      };
      const sendSnapshot = (sessionId: string, stream: Stream) => {
        const sequence = nextSequence(sessionId);
        const metadata =
          initial.snapshot.sessions.find(
            (session) => session.id === sessionId,
          ) ??
          ({
            id: sessionId,
            file: `/tmp/${sessionId}.jsonl`,
            cwd: '/tmp',
            title: sessionId,
            updatedAt: 1,
          } as Record<string, unknown>);
        enqueue(stream, `${sessionId}-snapshot-${sequence}`, {
          type: 'snapshot',
          sequence,
          snapshot: {
            metadata,
            entries: initial.entries[sessionId] ?? [],
            entriesComplete: true,
            serverId: initial.snapshot.serverId,
            cursor: sequence,
            active: {
              messages: [],
              tools: [],
              delegates: [],
              truncated: false,
            },
            completeThroughCursor: true,
          },
        });
        enqueue(stream, `${sessionId}-caught-up-${sequence}`, {
          type: 'caught-up',
          sequence,
        });
      };
      const createStream = (sessionId: string) => {
        const stream = {
          controller: undefined as
            | ReadableStreamDefaultController<Uint8Array>
            | undefined,
          close() {
            try {
              stream.controller?.error(new TypeError('network interrupted'));
            } catch {
              // The stream was already cancelled.
            }
          },
          sendEvent(event: Record<string, unknown>) {
            const sequence = nextSequence(sessionId);
            for (const candidate of streams.get(sessionId) ?? [])
              enqueue(candidate, `${sessionId}-event-${sequence}`, {
                type: 'session-event',
                sequence,
                sessionId,
                event,
              });
          },
        } as Stream;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            stream.controller = controller;
            const sessionStreams = streams.get(sessionId) ?? [];
            sessionStreams.push(stream);
            streams.set(sessionId, sessionStreams);
            controller.enqueue(
              encoder.encode(
                'event: connected\ndata: {"reconnectAfterInactivityMs":60000}\n\n',
              ),
            );
            sendSnapshot(sessionId, stream);
          },
        });
        return new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        });
      };
      const sessionIdFromRequest = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        try {
          const rawBody =
            typeof init?.body === 'string'
              ? init.body
              : input instanceof Request
                ? await input.clone().text()
                : '';
          const urlInput = new URL(
            String(input),
            window.location.href,
          ).searchParams.get('input');
          const parsed = rawBody
            ? JSON.parse(rawBody)
            : urlInput
              ? JSON.parse(urlInput)
              : {};
          const inputValue = parsed?.input ?? parsed?.json ?? parsed;
          return typeof inputValue?.sessionId === 'string'
            ? inputValue.sessionId
            : 'session-b';
        } catch {
          return 'session-b';
        }
      };

      window.fetch = async (input, init) => {
        const target =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (!target.includes('/trpc/sessionSubscribe'))
          return originalFetch(input, init);
        return createStream(await sessionIdFromRequest(input, init));
      };

      Object.assign(window, {
        liveScrollMock: {
          append(sessionId: string, text: string) {
            const messageId = `live-${sessionId}-${++messageNumber}`;
            const event = {
              type: 'message.started',
              sessionId,
              message: {
                messageId,
                role: 'assistant',
                timestamp: Date.now(),
                content: [{ type: 'text', text }],
              },
            };
            initial.entries[sessionId] ??= [];
            initial.entries[sessionId].push({
              type: 'message',
              id: messageId,
              message: {
                id: messageId,
                role: 'assistant',
                timestamp: Date.now(),
                content: [{ type: 'text', text }],
              },
            });
            streams.get(sessionId)?.at(-1)?.sendEvent(event);
            return messageId;
          },
          update(sessionId: string, messageId: string, text: string) {
            const event = {
              type: 'message.updated',
              sessionId,
              message: {
                messageId,
                role: 'assistant',
                timestamp: Date.now(),
                content: [{ type: 'text', text }],
              },
            };
            streams.get(sessionId)?.at(-1)?.sendEvent(event);
          },
        },
      });
    },
    {
      snapshot: {
        serverId: snapshot.serverId,
        cursor: snapshot.cursor,
        sessions: snapshot.sessions,
      },
      entries,
    },
  );
  await installDashboardBootstrap(page, snapshot);
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
}

async function navigateToSession(page: Page, sessionId: string) {
  await page.evaluate((pathname) => {
    window.history.pushState({}, '', pathname);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/sessions/${sessionId}`);
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}$`, 'u'));
  await expect(transcriptScroll(page)).toBeVisible();
  await expect
    .poll(() =>
      transcriptScroll(page).evaluate((element) => element.textContent ?? ''),
    )
    .toContain(sessionId === 'session-a' ? 'A transcript' : 'B transcript');
}

async function scrollToMiddleWithUserIntent(page: Page) {
  const scroll = transcriptScroll(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await scroll.evaluate((element) => {
    element.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, deltaY: -1_000 }),
    );
    element.scrollTop = Math.round(
      (element.scrollHeight - element.clientHeight) / 2,
    );
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect
    .poll(() => transcriptScroll(page).evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect.poll(() => transcriptGap(page)).toBeGreaterThan(120);
  // Virtualized rows measure after the native scroll event.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function visibleRowMemory(page: Page) {
  return transcriptScroll(page).evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const row = Array.from(
      element.querySelectorAll<HTMLElement>(
        '[data-transcript-row], [data-transcript-key]',
      ),
    ).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    if (!row) throw new Error('No visible transcript row to anchor.');
    const key = row.dataset.transcriptRow ?? row.dataset.transcriptKey;
    if (!key) throw new Error('Visible transcript row has no stable key.');
    return {
      key,
      offset: row.getBoundingClientRect().top - viewport.top,
    };
  });
}

async function expectRowMemory(
  page: Page,
  memory: { key: string; offset: number },
) {
  await expect
    .poll(() =>
      transcriptScroll(page).evaluate((element, saved) => {
        const viewport = element.getBoundingClientRect();
        const row = Array.from(
          element.querySelectorAll<HTMLElement>(
            '[data-transcript-row], [data-transcript-key]',
          ),
        ).find(
          (candidate) =>
            (candidate.dataset.transcriptRow ??
              candidate.dataset.transcriptKey) === saved.key,
        );
        return row
          ? Math.abs(
              row.getBoundingClientRect().top - viewport.top - saved.offset,
            )
          : Number.POSITIVE_INFINITY;
      }, memory),
    )
    .toBeLessThanOrEqual(8);
}

for (const rowCount of [40, 120]) {
  test(`keeps live scroll anchors across A/B navigation with ${rowCount} rows`, async ({
    page,
  }) => {
    const snapshot = {
      serverId: `live-scroll-${rowCount}`,
      revision: 1,
      cursor: 1,
      runtimes: [],
      workspaces: [],
      sessions: [
        {
          id: 'session-a',
          file: '/tmp/session-a.jsonl',
          cwd: '/tmp',
          title: 'Session A',
          updatedAt: 1,
        },
        {
          id: 'session-b',
          file: '/tmp/session-b.jsonl',
          cwd: '/tmp',
          title: 'Session B',
          updatedAt: 2,
        },
      ],
      unread: [],
    };
    const entries = {
      'session-a': sessionEntries('A', rowCount),
      'session-b': sessionEntries('B', rowCount),
    };
    await installLiveSessionMock(page, snapshot, entries);

    await page.goto('/sessions/session-b');
    await expect(
      page.getByText(`B transcript row ${rowCount}`, { exact: true }),
    ).toBeVisible();
    await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(2);

    // Establish B's manual position with an actual wheel-intent event.
    await scrollToMiddleWithUserIntent(page);
    const bAnchor = await visibleRowMemory(page);

    // A starts at the latest position, and its first live output must follow.
    await navigateToSession(page, 'session-a');
    await expect(
      page.getByText(`A transcript row ${rowCount}`, { exact: true }),
    ).toBeVisible();
    await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(2);
    await page.evaluate(() => {
      (
        window as unknown as {
          liveScrollMock: { append(sessionId: string, text: string): string };
        }
      ).liveScrollMock.append('session-a', 'A live output 1');
    });
    await expect(
      page.getByText('A live output 1', { exact: true }),
    ).toBeVisible();
    await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(2);

    // Return to B without forcing its scroll position. A continues on its
    // retained stream while B receives output at its manual anchor.
    await navigateToSession(page, 'session-b');
    await expectRowMemory(page, bAnchor);
    await expect.poll(() => transcriptGap(page)).toBeGreaterThan(120);
    await page.evaluate(() => {
      const mock = (
        window as unknown as {
          liveScrollMock: {
            append(sessionId: string, text: string): string;
          };
        }
      ).liveScrollMock;
      mock.append('session-a', 'A live output 2 while B is open');
      mock.append('session-b', 'B live output 1');
    });
    // Let the stream consumer and React commit the offscreen output. Its
    // presence is checked at the end, once Jump latest makes it renderable.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expectRowMemory(page, bAnchor);
    await expect.poll(() => transcriptGap(page)).toBeGreaterThan(120);

    // Repeat A-B-A-B while A's inactive stream is still allowed to emit.
    await navigateToSession(page, 'session-a');
    await expect(
      page.getByText('A live output 2 while B is open', { exact: true }),
    ).toBeVisible();
    await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(2);
    await page.evaluate(() => {
      (
        window as unknown as {
          liveScrollMock: { append(sessionId: string, text: string): string };
        }
      ).liveScrollMock.append('session-a', 'A live output 3');
    });
    await expect(
      page.getByText('A live output 3', { exact: true }),
    ).toBeVisible();
    await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(2);

    await navigateToSession(page, 'session-b');
    await expectRowMemory(page, bAnchor);
    await expect.poll(() => transcriptGap(page)).toBeGreaterThan(120);
    await page.evaluate(() => {
      const mock = (
        window as unknown as {
          liveScrollMock: {
            append(sessionId: string, text: string): string;
          };
        }
      ).liveScrollMock;
      mock.append('session-a', 'A live output 4 while B is open');
      mock.append('session-b', 'B live output 2');
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expectRowMemory(page, bAnchor);
    await expect.poll(() => transcriptGap(page)).toBeGreaterThan(120);

    await page
      .getByRole('button', { name: 'Jump to latest transcript activity' })
      .click();
    await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(2);
    await expect(
      page.getByText('B live output 1', { exact: true }),
    ).toBeAttached();
    await expect(
      page.getByText('B live output 2', { exact: true }),
    ).toBeAttached();
    await page.evaluate(() => {
      (
        window as unknown as {
          liveScrollMock: { append(sessionId: string, text: string): string };
        }
      ).liveScrollMock.append('session-b', 'B live output after jump');
    });
    await expect(
      page.getByText('B live output after jump', { exact: true }),
    ).toBeVisible();
    await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(2);

    // A restoration/measurement scroll can momentarily reach the end. It is
    // not user permission to resume following the next streaming update.
    await transcriptScroll(page).evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -240 }));
      element.scrollTop = Math.max(0, element.scrollTop - 240);
      element.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(() => transcriptGap(page)).toBeGreaterThan(120);
    await transcriptScroll(page).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    const extraOutput =
      'More streamed content without user follow intent. '.repeat(60);
    await page.evaluate((text) => {
      (
        window as unknown as {
          liveScrollMock: { append(id: string, text: string): string };
        }
      ).liveScrollMock.append('session-b', text);
    }, extraOutput);
    await expect(
      page.getByText(extraOutput.trim(), { exact: true }),
    ).toBeAttached();
    await expect.poll(() => transcriptGap(page)).toBeGreaterThan(120);
  });
}
