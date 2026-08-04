import { expect, test } from '@playwright/test';

test('mobile dashboard renders and supports the new-agent route', async ({
  page,
}) => {
  await page.route('**/api/usage', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/snapshot', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        revision: 1,
        runtimes: [
          {
            runtimeId: 'ghost',
            ownership: 'external',
            pid: 1,
            cwd: '/tmp',
            liveState: 'idle',
            online: false,
            session: { id: 'ghost-session', entries: [] },
            pendingInteractions: [],
          },
        ],
        workspaces: [
          {
            id: 'w',
            name: 'Demo',
            path: '/tmp',
            canonicalPath: '/tmp',
            source: 'directory',
            active: false,
          },
        ],
        sessions: [],
        unread: [],
      }),
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await expect(page.getByText('No runtimes are connected.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Untitled session offline' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Agent' })).toBeVisible();
  expect(
    await page
      .locator('body')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.getByRole('button', { name: '+ Agent' }).click();
  await expect(
    page.getByRole('heading', { name: 'Start an agent' }),
  ).toBeVisible();
  await expect(page.getByLabel('Workspace')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start in a new tmux window' }),
  ).toBeVisible();
});

test('live transport contains malformed data and reconnects without HTTP polling', async ({
  page,
}) => {
  let usageRequests = 0;
  let snapshotRequests = 0;
  await page.addInitScript(() => {
    localStorage.setItem('pi-dashboard-token', 'test-token');
    type Stream = {
      controller?: ReadableStreamDefaultController<Uint8Array>;
      emit(value: unknown): void;
      emitRaw(data: string): void;
      close(): void;
      response: Response;
    };
    const streams: Stream[] = [];
    let nextCursor = 0;
    let reconnectSnapshotPending = false;
    let replayGapPending = false;
    const originalFetch = window.fetch.bind(window);
    const frame = (data: string) => `event: dashboard\ndata: ${data}\n\n`;
    const generationSnapshot = (generation: number) => ({
      serverId: `server-${generation}`,
      revision: 1,
      cursor: ++nextCursor,
      runtimes: [],
      workspaces: [
        {
          id: `workspace-${generation}`,
          name: `Live generation ${generation}`,
          path: '/tmp',
          canonicalPath: '/tmp',
          source: 'directory',
          active: false,
        },
      ],
      sessions: [],
      unread: [
        {
          id: `generation-${generation}`,
          kind: 'settled',
          title: `Live generation ${generation}`,
          body: 'Generation marker',
          createdAt: generation,
        },
      ],
    });
    const streamRecord = (value: {
      type?: string;
      snapshot?: Record<string, unknown>;
      runtimeId?: string;
      event?: unknown;
    }) => {
      const malformedSnapshot =
        value.type === 'snapshot' &&
        Array.isArray(value.snapshot?.runtimes) &&
        value.snapshot.runtimes.some(
          (runtime) =>
            !runtime ||
            typeof runtime !== 'object' ||
            !('runtimeId' in runtime),
        );
      const cursor = malformedSnapshot ? nextCursor : ++nextCursor;
      if (value.type === 'snapshot') {
        const snapshot = { ...value.snapshot, cursor };
        return { type: 'snapshot', cursor, emittedAt: Date.now(), snapshot };
      }
      return {
        cursor,
        emittedAt: Date.now(),
        runtimeId: value.runtimeId,
        event: value.event,
      };
    };
    const createStream = (): Stream => {
      const stream = {
        response: undefined as unknown as Response,
        emit(value: unknown) {
          try {
            stream.controller?.enqueue(
              new TextEncoder().encode(
                frame(JSON.stringify(streamRecord(value))),
              ),
            );
          } catch {
            /* stale test streams are intentionally inert after close */
          }
        },
        emitRaw(data) {
          try {
            stream.controller?.enqueue(new TextEncoder().encode(frame(data)));
          } catch {
            /* stale test streams are intentionally inert after close */
          }
        },
        close() {
          reconnectSnapshotPending = true;
          try {
            stream.controller?.close();
          } catch {
            /* parser errors already cancel the stale stream */
          }
        },
      } as Stream;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream.controller = controller;
        },
      });
      stream.response = new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
      streams.push(stream);
      return stream;
    };
    window.fetch = async (input, init) => {
      const target = typeof input === 'string' ? input : input.url;
      if (!target.includes('/api/events')) return originalFetch(input, init);
      if (replayGapPending) {
        replayGapPending = false;
        return new Response(JSON.stringify({ code: 'replay-gap' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
      const stream = createStream();
      if (streams.length === 1 || reconnectSnapshotPending) {
        reconnectSnapshotPending = false;
        const snapshot = generationSnapshot(streams.length);
        stream.controller?.enqueue(
          new TextEncoder().encode(
            frame(
              JSON.stringify({
                type: 'snapshot',
                cursor: snapshot.cursor,
                emittedAt: Date.now(),
                snapshot,
              }),
            ),
          ),
        );
      }
      return stream.response;
    };
    Object.assign(window, {
      dashboardLiveTest: {
        count: () => streams.length,
        current: () => streams.at(-1),
        first: () => streams[0],
        forceReplayGap: () => {
          replayGapPending = true;
          streams.at(-1)?.close();
        },
      },
    });
  });
  await page.route('**/api/usage', async (route) => {
    usageRequests += 1;
    await route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  page.on('request', (request) => {
    if (request.url().includes('/api/snapshot')) snapshotRequests += 1;
  });
  await page.route('**/api/snapshot', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        serverId: 'server-1',
        revision: 1,
        runtimes: [],
        workspaces: [
          {
            id: 'workspace-1',
            name: 'Live generation 1',
            path: '/tmp',
            canonicalPath: '/tmp',
            source: 'directory',
            active: false,
          },
        ],
        sessions: [],
        unread: [
          {
            id: 'generation-1',
            kind: 'settled',
            title: 'Live generation 1',
            body: 'Generation marker',
            createdAt: 1,
          },
        ],
      }),
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await expect.poll(() => usageRequests).toBeGreaterThan(0);
  await expect.poll(() => snapshotRequests).toBe(1);
  expect(usageRequests).toBe(1);
  const initialUsageRequests = usageRequests;
  await page.evaluate(() => {
    (
      window as unknown as {
        dashboardLiveTest: { current(): { emit(value: unknown): void } };
      }
    ).dashboardLiveTest
      .current()
      .emit({
        type: 'snapshot',
        snapshot: {
          serverId: 'server-1',
          revision: 2,
          runtimes: [],
          workspaces: [],
          sessions: [],
          unread: [],
        },
      });
  });
  await page.waitForTimeout(150);
  expect(usageRequests).toBe(initialUsageRequests);
  await page.evaluate(() => {
    const test = (
      window as unknown as {
        dashboardLiveTest: {
          current(): {
            emitRaw(data: string): void;
            emit(value: unknown): void;
          };
        };
      }
    ).dashboardLiveTest;
    test.current().emitRaw('{not-json');
    test.current().emit({
      type: 'snapshot',
      snapshot: {
        serverId: 'broken',
        revision: 2,
        runtimes: [{}],
        workspaces: [],
        sessions: [],
        unread: [],
      },
    });
  });
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as {
        dashboardLiveTest: { current(): { close(): void } };
      }
    ).dashboardLiveTest
      .current()
      .close();
  });
  await expect(page.getByRole('status')).toContainText(
    'Live updates disconnected',
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            dashboardLiveTest: { count(): number };
          }
        ).dashboardLiveTest.count(),
      ),
    )
    .toBeGreaterThan(1);
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(usageRequests).toBe(initialUsageRequests);
  await page.waitForTimeout(200);
  await expect(page.getByText(/Live generation \d+/)).toBeVisible();
  const snapshotsBeforeReplayGap = snapshotRequests;
  await page.evaluate(() => {
    (
      window as unknown as { dashboardLiveTest: { forceReplayGap(): void } }
    ).dashboardLiveTest.forceReplayGap();
  });
  await expect
    .poll(() => snapshotRequests)
    .toBeGreaterThan(snapshotsBeforeReplayGap);
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as {
        dashboardLiveTest: { first(): { emit(value: unknown): void } };
      }
    ).dashboardLiveTest
      .first()
      .emit({
        type: 'snapshot',
        snapshot: {
          serverId: 'server-1',
          revision: 99,
          runtimes: [],
          workspaces: [
            {
              id: 'stale',
              name: 'ROLLED BACK',
              path: '/tmp',
              canonicalPath: '/tmp',
              source: 'directory',
              active: false,
            },
          ],
          sessions: [],
          unread: [
            {
              id: 'stale',
              kind: 'settled',
              title: 'ROLLED BACK',
              body: 'Stale generation marker',
              createdAt: 99,
            },
          ],
        },
      });
  });
  await expect(page.getByText(/Live generation \d+/)).toBeVisible();
  await expect(page.getByText('ROLLED BACK')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
});

test('dense mobile session keeps conversation and activity readable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.addInitScript(() => {
    localStorage.setItem('pi-dashboard-token', 'test-token');
    let cursor = 0;
    const originalFetch = window.fetch.bind(window);
    const stream = {
      controller: undefined as
        | ReadableStreamDefaultController<Uint8Array>
        | undefined,
      response: undefined as unknown as Response,
      emit(value: { runtimeId?: string; event?: unknown }) {
        const next = ++cursor;
        stream.controller?.enqueue(
          new TextEncoder().encode(
            `event: dashboard\ndata: ${JSON.stringify({
              cursor: next,
              emittedAt: Date.now(),
              runtimeId: value.runtimeId,
              event: value.event,
            })}\n\n`,
          ),
        );
      },
    };
    window.fetch = async (input, init) => {
      const target = typeof input === 'string' ? input : input.url;
      if (!target.includes('/api/events')) return originalFetch(input, init);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream.controller = controller;
        },
      });
      stream.response = new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
      Object.assign(window, { dashboardTestSocket: stream });
      return stream.response;
    };
  });
  await page.route('**/api/usage', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/snapshot', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        revision: 1,
        runtimes: [
          {
            runtimeId: 'r1',
            ownership: 'external',
            pid: 1,
            cwd: '/tmp',
            liveState: 'idle',
            session: { id: 's1', entries: [] },
            model: {
              provider: 'test',
              model: 'vision',
              supportsImages: true,
            },
            contextUsage: {
              tokens: 136_000,
              contextWindow: 272_000,
              percent: 50,
            },
            pendingInteractions: [],
          },
        ],
        workspaces: [],
        sessions: [],
        unread: [],
      }),
    }),
  );
  let commandContentType = '';
  let commandBody = '';
  await page.route(/\/api\/runtimes\/r1\/command$/, async (route) => {
    commandContentType = route.request().headers()['content-type'] ?? '';
    commandBody = route.request().postData() ?? '';
    await route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/sessions\/[^/]+$/, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        metadata: { id: 's1', file: '', cwd: '/tmp', updatedAt: Date.now() },
        entries: [
          ...Array.from({ length: 90 }, (_, index) => ({
            type: 'message',
            message: {
              role: 'user',
              content: [{ type: 'text', text: `Earlier message ${index + 1}` }],
            },
          })),
          {
            type: 'message',
            message: {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: '**Check** the [dashboard](https://example.com).',
                },
              ],
            },
          },
          {
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Checking the mobile transcript.' },
                {
                  type: 'toolCall',
                  id: 'call-1',
                  name: 'read',
                  arguments: { path: 'src/App.tsx' },
                },
              ],
            },
          },
          {
            type: 'message',
            message: {
              role: 'toolResult',
              toolCallId: 'call-1',
              content: [{ type: 'text', text: 'ok' }],
              isError: false,
            },
          },
          {
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'Result: **ready** with `inline code`.',
                },
              ],
            },
          },
        ],
      }),
    });
  });
  await page.goto('/sessions/s1');
  await expect(page.getByText('Check', { exact: true })).toBeVisible();
  const userLink = page.getByRole('link', { name: 'dashboard' });
  await expect(userLink).toHaveAttribute('href', 'https://example.com');
  await expect(userLink).toHaveAttribute('target', '_blank');
  await expect(page.getByText('ready', { exact: true })).toBeVisible();
  await expect(page.getByText('inline code', { exact: true })).toBeVisible();
  const activity = page.getByRole('button', {
    name: /Checking the mobile transcript.*1 tool/,
  });
  await expect(activity).toBeVisible();
  await expect(page.getByLabel('Message Pi')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Attach images' }),
  ).toBeVisible();
  const imageInput = page.getByLabel('Choose images');
  await imageInput.setInputFiles({
    name: 'picker.png',
    mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71]),
  });
  await expect(page.getByAltText('picker.png')).toBeVisible();
  await page.getByRole('button', { name: 'Remove picker.png' }).click();
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array([1])], 'paste.webp', { type: 'image/webp' }),
    );
    document.querySelector('textarea')?.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  });
  await expect(page.getByAltText('paste.webp')).toBeVisible();
  await page.evaluate(() => {
    const composer = document.querySelector('.composer');
    if (!composer) throw new Error('Composer not found');
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array([2])], 'drop.jpeg', { type: 'image/jpeg' }),
    );
    composer.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  await expect(page.getByAltText('drop.jpeg')).toBeVisible();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => commandBody).toContain('"text":""');
  expect(commandContentType).toMatch(/^multipart\/form-data; boundary=/);
  expect(commandBody).toContain('name="command"');
  expect(commandBody).toContain('name="images"');
  expect(commandBody).toContain('paste.webp');
  expect(commandBody).toContain('drop.jpeg');
  await expect(page.getByAltText('paste.webp')).toHaveCount(0);
  await expect(page.getByLabel('Context window 50% [136k/272k]')).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.scrollY + window.innerHeight >=
        document.documentElement.scrollHeight - 2,
    ),
  ).toBe(true);
  expect(
    await page
      .locator('.composer')
      .evaluate(
        (element) =>
          document.documentElement.scrollHeight -
          (window.scrollY + element.getBoundingClientRect().bottom),
      ),
  ).toBeLessThanOrEqual(12);
  await activity.click();
  await expect(page.locator('.tool-chip').getByText('read')).toBeVisible();
  await activity.click();
  const emitAssistant = async (content: unknown[]) =>
    page.evaluate((assistantContent) => {
      (
        window as unknown as {
          dashboardTestSocket: { emit(value: unknown): void };
        }
      ).dashboardTestSocket.emit({
        type: 'event',
        serverId: 'legacy',
        revision: assistantContent.length,
        runtimeId: 'r1',
        event: {
          type: 'message.updated',
          sessionId: 's1',
          message: {
            messageId: 'live-assistant-turn',
            role: 'assistant',
            content: assistantContent,
          },
        },
      });
    }, content);
  await emitAssistant([{ type: 'text', text: 'Preparing live tool.' }]);
  await expect(
    page.getByText('preparing tool call', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.message-assistant')).not.toContainText(
    'Preparing live tool.',
  );
  await emitAssistant([
    { type: 'text', text: 'Preparing live tool.' },
    {
      type: 'toolCall',
      id: 'live-call',
      name: 'read',
      arguments: { path: 'src/live.ts' },
    },
  ]);
  await expect(
    page.getByRole('button', { name: /Preparing live tool.*1 tool/ }),
  ).toBeVisible();
  const emitMessage = async (type: string, timestamp: number, text: string) =>
    page.evaluate(
      ({ type, timestamp, text }) => {
        (
          window as unknown as {
            dashboardTestSocket: { emit(value: unknown): void };
          }
        ).dashboardTestSocket.emit({
          type: 'event',
          serverId: 'legacy',
          revision: timestamp + (type.endsWith('finished') ? 1 : 0),
          runtimeId: 'r1',
          event: {
            type,
            sessionId: 's1',
            message: {
              messageId: `live-user-${timestamp}`,
              role: 'user',
              timestamp,
              content: [{ type: 'text', text }],
            },
          },
        });
      },
      { type, timestamp, text },
    );
  await emitMessage('message.started', 123, 'Live dashboard message');
  await expect(page.getByText('Live dashboard message')).toHaveCount(1);
  // Reload while the authenticated stream is active; the session baseline and
  // transcript projection must hydrate without relying on the old page state.
  await page.reload();
  await expect(page.getByText('ready', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Message Pi')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.scrollY + window.innerHeight >=
          document.documentElement.scrollHeight - 2,
      ),
    )
    .toBe(true);
  await emitMessage('message.finished', 123, 'Live dashboard message');
  await expect(page.getByText('Live dashboard message')).toHaveCount(1);
  await page.evaluate(() => {
    (
      window as unknown as {
        dashboardTestSocket: { emit(value: unknown): void };
      }
    ).dashboardTestSocket.emit({
      type: 'event',
      serverId: 'legacy',
      revision: 1000,
      runtimeId: 'r1',
      event: { type: 'agent.settled', sessionId: 's1' },
    });
  });
  await emitMessage('message.started', 321, 'Delta during settled turn');
  await expect(page.getByText('Delta during settled turn')).toBeVisible();
  await page.evaluate(() => window.scrollBy(0, -400));
  await emitMessage('message.started', 456, 'Message while reading history');
  await expect(page.getByText('Message while reading history')).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollHeight -
          (window.scrollY + window.innerHeight),
      ),
    )
    .toBeGreaterThan(120);
  expect(
    await page
      .locator('body')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});
