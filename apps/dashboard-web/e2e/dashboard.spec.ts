import { expect, type Page, test } from '@playwright/test';

test('mobile dashboard renders and supports the new-agent route', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
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
            cwd: '/Users/example/this-is-a-deliberately-long-workspace-path/with-more-segments/project',
            liveState: 'idle',
            online: false,
            session: {
              id: 'ghost-session',
              title: 'A deliberately long session title that must wrap safely',
              entries: [],
            },
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
    page.getByRole('button', {
      name: 'A deliberately long session title that must wrap safely offline',
    }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Agent' })).toBeVisible();
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toBeVisible();
  await expect(page.getByRole('option', { name: /Dashboard/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /New Agent/ })).toBeVisible();
  await expect(
    page.getByRole('option', { name: /Workspace: Demo/ }),
  ).toBeVisible();
  await expect(
    page.getByText('No actions available from connected runtimes.'),
  ).toBeVisible();
  await page.getByLabel('Filter actions and navigation').fill('does-not-exist');
  await expect(
    page.getByText('No results for “does-not-exist”.'),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Open command palette' }),
  ).toBeFocused();
  await page.keyboard.press('Control+k');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toHaveCount(0);
  await page.keyboard.press('Meta+k');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toBeVisible();
  await page.keyboard.press('Meta+k');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page.getByRole('option', { name: /New Agent/ }).click();
  expect(
    await page
      .locator('body')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await expect(
    page.getByRole('heading', { name: 'Start an agent' }),
  ).toBeVisible();
  await expect(page.getByLabel('Workspace')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start in a new tmux window' }),
  ).toBeVisible();
});

test('command palette identifies the runtime before invoking repeated actions', async ({
  page,
}) => {
  const runtime = (runtimeId: string, title: string, cwd: string) => ({
    runtimeId,
    ownership: 'external',
    pid: 1,
    cwd,
    liveState: 'working',
    online: true,
    session: { id: `session-${runtimeId}`, title, entries: [] },
    pendingInteractions: [],
    capabilities: {
      version: 1,
      capabilities: [],
      manifests: [
        {
          id: `manifest-${runtimeId}`,
          version: '1',
          actions: [{ id: 'runtime.abort', title: 'Abort run' }],
          renderers: [],
        },
      ],
    },
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
          runtime('runtime-alpha', 'Alpha agent', '/workspace/alpha'),
          runtime('runtime-beta', 'Beta agent', '/workspace/beta'),
        ],
        workspaces: [],
        sessions: [],
        unread: [],
      }),
    }),
  );
  let invokedRuntime: string | undefined;
  await page.route('**/api/runtimes/*/command', async (route) => {
    invokedRuntime = new URL(route.request().url()).pathname.split('/')[3];
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ accepted: true }),
    });
  });
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Open command palette' }),
  ).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByLabel('Filter actions and navigation').fill('runtime-beta');
  const option = page.getByRole('option', { name: /Abort run/ });
  await expect(option).toHaveCount(1);
  await expect(option).toContainText(
    'Target: runtime-beta · Beta agent · /workspace/beta',
  );
  await option.click();
  await expect.poll(() => invokedRuntime).toBe('runtime-beta');
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
  await page.goto('/workspaces');
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
  await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();
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
  await page.goto('/workspaces');
  await expect(page.getByText(/Live generation \d+/)).toBeVisible();
  await expect(page.getByText('ROLLED BACK')).toHaveCount(0);
  await page.goto('/');
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
  const composerHeightBeforeAttachment = await page
    .locator('.composer')
    .evaluate((element) => element.getBoundingClientRect().height);
  await imageInput.setInputFiles({
    name: 'picker.png',
    mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71]),
  });
  await expect(page.getByAltText('picker.png')).toBeVisible();
  const floatingAttachmentLayout = await page.evaluate(() => {
    const composer = document.querySelector('.composer');
    const previews = document.querySelector('.composer-previews');
    if (!composer || !previews) throw new Error('Composer previews not found');
    const composerRect = composer.getBoundingClientRect();
    const previewsRect = previews.getBoundingClientRect();
    return {
      composerHeight: composerRect.height,
      previewsBottom: previewsRect.bottom,
      composerTop: composerRect.top,
    };
  });
  expect(floatingAttachmentLayout.composerHeight).toBe(
    composerHeightBeforeAttachment,
  );
  expect(floatingAttachmentLayout.previewsBottom).toBeLessThanOrEqual(
    floatingAttachmentLayout.composerTop,
  );
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
  ).toBeLessThanOrEqual(80);
  await activity.click();
  await expect(page.locator('.tool-chip').getByText('read')).toBeVisible();
  await expect(
    page.getByText('read src/App.tsx', { exact: true }),
  ).toBeVisible();
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

const phase6ActionSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

function phase6Capabilities() {
  return {
    version: 1,
    capabilities: [
      {
        id: 'remote-control.semantic-actions',
        version: '1',
        available: true,
      },
      { id: 'activity-groups', version: '1', available: true },
      { id: 'interaction.ask_user', version: '1', available: true },
    ],
    manifests: [
      {
        id: 'remote-control',
        version: '1',
        actions: [
          {
            id: 'session.compact',
            title: 'Compact session',
            inputSchema: {
              type: 'object',
              properties: { customInstructions: { type: 'string' } },
              additionalProperties: false,
            },
            availability: {
              requires: ['remote-control.semantic-actions'],
              liveStates: ['idle', 'working', 'waiting'],
            },
          },
          {
            id: 'runtime.abort',
            title: 'Abort run',
            inputSchema: phase6ActionSchema,
            availability: {
              requires: ['remote-control.semantic-actions'],
              liveStates: ['working', 'waiting', 'aborting'],
            },
          },
          {
            id: 'unsafe.action',
            title: 'Unsafe unavailable action',
            inputSchema: phase6ActionSchema,
            availability: { requires: ['missing-capability'] },
          },
        ],
        renderers: [],
      },
      {
        id: 'activity-groups',
        version: '1',
        actions: [
          {
            id: 'activity-groups.set',
            title: 'Set activity groups',
            inputSchema: {
              type: 'object',
              properties: {
                expanded: { type: 'boolean' },
                enabled: { type: 'boolean' },
              },
              minProperties: 1,
              additionalProperties: false,
            },
            availability: { requires: ['activity-groups'] },
          },
        ],
        renderers: [],
      },
      {
        id: 'ask-user',
        version: '1',
        actions: [
          {
            id: 'ask-user.answer',
            title: 'Answer question',
            inputSchema: {
              type: 'object',
              required: ['interactionId', 'answer'],
              properties: {
                interactionId: { type: 'string' },
                answer: { type: 'string' },
              },
              additionalProperties: false,
            },
            availability: {
              requires: ['interaction.ask_user'],
              pendingInteraction: true,
            },
          },
          {
            id: 'ask-user.cancel',
            title: 'Cancel question',
            inputSchema: {
              type: 'object',
              required: ['interactionId'],
              properties: { interactionId: { type: 'string' } },
              additionalProperties: false,
            },
            availability: {
              requires: ['interaction.ask_user'],
              pendingInteraction: true,
            },
          },
        ],
        renderers: [],
      },
    ],
  };
}

function phase6Interaction(id: string, question: string) {
  const choices = [
    {
      label: 'Yes',
      value: 'yes',
      preview: 'Use the **recommended** answer. [Preview docs](#preview-docs)',
    },
    {
      label: 'No',
      value: 'no',
      preview: 'Keep the current behavior instead.',
    },
  ];
  return {
    id,
    type: 'ask_user',
    question,
    choices,
    allowCustom: false,
    rendererId: 'ask-user.question',
    viewModel: {
      id,
      question,
      choices,
      allowCustom: false,
    },
    answerActionId: 'ask-user.answer',
    cancelActionId: 'ask-user.cancel',
    createdAt: 1,
  };
}

function phase6Entries() {
  return [
    ...Array.from({ length: 84 }, (_, index) => ({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `Earlier history ${index + 1}` }],
      },
    })),
    {
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Existing session request' }],
      },
    },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '**Inspecting history**' },
          {
            type: 'toolCall',
            id: 'history-read',
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
        toolCallId: 'history-read',
        content: [{ type: 'text', text: 'history contents' }],
        isError: false,
      },
    },
  ];
}

function phase6Snapshot(
  overrides: {
    liveState?: string;
    pendingInteractions?: unknown[];
    workspaces?: unknown[];
    unread?: unknown[];
  } = {},
) {
  return {
    serverId: 'phase-six',
    revision: 1,
    cursor: 1,
    runtimes: [
      {
        runtimeId: 'r1',
        ownership: 'managed',
        pid: 42,
        cwd: '/tmp/project',
        liveState: overrides.liveState ?? 'waiting',
        online: true,
        session: { id: 's1', entries: [] },
        model: {
          provider: 'test',
          model: 'vision',
          thinking: 'medium',
          supportsImages: true,
        },
        modelCatalog: [
          {
            provider: 'test',
            model: 'vision',
            name: 'Vision',
            supportsImages: true,
          },
          {
            provider: 'test',
            model: 'text',
            name: 'Text only',
            supportsImages: false,
          },
        ],
        thinkingLevels: ['off', 'low', 'medium', 'high'],
        pendingInteractions: overrides.pendingInteractions ?? [
          phase6Interaction('ask-1', 'Use the first answer?'),
          phase6Interaction('ask-2', 'Use the second answer?'),
        ],
        capabilities: phase6Capabilities(),
      },
    ],
    workspaces: overrides.workspaces ?? [
      {
        id: 'w1',
        name: 'Project',
        path: '/tmp/project',
        canonicalPath: '/tmp/project',
        source: 'directory',
        active: true,
      },
    ],
    sessions: [
      {
        id: 's1',
        file: '/tmp/project/session.jsonl',
        cwd: '/tmp/project',
        workspaceId: 'w1',
        title: 'Existing session request',
        updatedAt: 1,
        activeRuntimeId: 'r1',
        entryCount: 87,
      },
    ],
    unread: overrides.unread ?? [
      {
        id: 'notice-1',
        kind: 'settled',
        title: 'Agent settled',
        body: 'The existing session is ready.',
        createdAt: 1,
      },
    ],
  };
}

async function installPhase6Mocks(page: Page) {
  const commands: Array<Record<string, unknown>> = [];
  const starts: Array<Record<string, unknown>> = [];
  const stops: Array<Record<string, unknown>> = [];
  const restarts: Array<Record<string, unknown>> = [];
  await page.addInitScript(() => {
    localStorage.setItem('pi-dashboard-token', 'test-token');
    const streams: Array<{
      controller?: ReadableStreamDefaultController<Uint8Array>;
      close(): void;
      emit(value: Record<string, unknown>): void;
    }> = [];
    let cursor = 1;
    const originalFetch = window.fetch.bind(window);
    const makeFrame = (value: unknown) =>
      `event: dashboard\ndata: ${JSON.stringify(value)}\n\n`;
    const createStream = () => {
      const stream = {
        controller: undefined as
          | ReadableStreamDefaultController<Uint8Array>
          | undefined,
        close() {
          try {
            stream.controller?.close();
          } catch {
            /* closed test stream */
          }
        },
        emit(value: Record<string, unknown>) {
          const record =
            value.type === 'snapshot'
              ? {
                  ...value,
                  cursor: ++cursor,
                  snapshot: {
                    ...(value.snapshot as Record<string, unknown>),
                    cursor,
                  },
                  emittedAt: Date.now(),
                }
              : {
                  ...value,
                  cursor: ++cursor,
                  emittedAt: Date.now(),
                };
          try {
            stream.controller?.enqueue(
              new TextEncoder().encode(makeFrame(record)),
            );
          } catch {
            /* stale stream */
          }
        },
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream.controller = controller;
        },
      });
      streams.push(stream);
      return {
        stream,
        response: new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      };
    };
    window.fetch = async (input, init) => {
      const target = typeof input === 'string' ? input : input.url;
      if (!target.includes('/api/events')) return originalFetch(input, init);
      return createStream().response;
    };
    Object.assign(window, {
      phase6Stream: {
        current: () => streams.at(-1),
        count: () => streams.length,
      },
    });
  });
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(phase6Snapshot()),
    }),
  );
  await page.route('**/api/sessions/s1', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        serverId: 'phase-six',
        cursor: 1,
        metadata: {
          id: 's1',
          file: '/tmp/project/session.jsonl',
          cwd: '/tmp/project',
          title: 'Existing session request',
          updatedAt: 1,
          activeRuntimeId: 'r1',
          entryCount: 87,
        },
        entries: phase6Entries(),
      }),
    }),
  );
  await page.route('**/api/workspaces/refresh', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [
          {
            id: 'w1',
            name: 'Refreshed project',
            path: '/tmp/project',
            canonicalPath: '/tmp/project',
            source: 'directory',
            active: true,
          },
        ],
      }),
    }),
  );
  await page.route('**/api/runtimes/start', async (route) => {
    try {
      starts.push(
        JSON.parse(route.request().postData() ?? '{}') as Record<
          string,
          unknown
        >,
      );
    } catch {
      starts.push({});
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ runtimeId: 'r-launched' }),
    });
  });
  await page.route('**/api/runtimes/r1/restart', async (route) => {
    try {
      restarts.push(
        JSON.parse(route.request().postData() ?? '{}') as Record<
          string,
          unknown
        >,
      );
    } catch {
      restarts.push({});
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, result: { runtimeId: 'r-restarted' } }),
    });
  });
  await page.route('**/api/runtimes/r1/stop', async (route) => {
    try {
      stops.push(
        JSON.parse(route.request().postData() ?? '{}') as Record<
          string,
          unknown
        >,
      );
    } catch {
      stops.push({});
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
  await page.route('**/api/runtimes/r1/command', async (route) => {
    const contentType = route.request().headers()['content-type'] ?? '';
    const body = route.request().postData() ?? '';
    if (contentType.startsWith('application/json')) {
      try {
        commands.push(JSON.parse(body) as Record<string, unknown>);
      } catch {
        commands.push({ type: 'invalid-json' });
      }
    } else commands.push({ type: 'multipart', body });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, result: { accepted: true } }),
    });
  });
  await page.route('**/api/push/vapid-public-key', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ publicKey: null }),
    }),
  );
  return {
    commands,
    starts,
    stops,
    restarts,
    emit: async (value: Record<string, unknown>) =>
      page.evaluate((record) => {
        (
          window as unknown as {
            phase6Stream: {
              current(): { emit(value: Record<string, unknown>): void };
            };
          }
        ).phase6Stream
          .current()
          .emit(record);
      }, value),
    close: async () =>
      page.evaluate(() =>
        (
          window as unknown as {
            phase6Stream: { current(): { close(): void } };
          }
        ).phase6Stream
          .current()
          .close(),
      ),
    streamCount: () =>
      page.evaluate(() =>
        (
          window as unknown as { phase6Stream: { count(): number } }
        ).phase6Stream.count(),
      ),
  };
}

test('phase six mocked session flow covers semantic controls and reconnect safety', async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.context().grantPermissions(['notifications']);
  const mocks = await installPhase6Mocks(page);
  await page.goto('/sessions/s1');
  await expect(
    page.getByRole('heading', { name: 'Existing session request' }),
  ).toBeVisible();
  await mocks.emit({ type: 'snapshot', snapshot: phase6Snapshot() });
  await expect(page.getByLabel('Model')).toHaveCount(0);
  await expect(page.locator('.session-heading')).toContainText(
    'test/vision · medium',
  );
  await page.getByLabel('Thinking level').selectOption('high');
  expect(
    mocks.commands.filter((command) => command.type === 'setModel'),
  ).toHaveLength(0);
  await expect
    .poll(
      () =>
        mocks.commands.filter((command) => command.type === 'setThinking')
          .length,
    )
    .toBe(1);

  await expect(page.getByRole('dialog')).toHaveCount(2);
  const firstInteraction = page.getByRole('dialog').nth(0);
  await firstInteraction.focus();
  await firstInteraction.press('ArrowDown');
  await expect(
    firstInteraction.getByText('Keep the current behavior instead.'),
  ).toBeVisible();
  await firstInteraction.press('ArrowUp');
  const previewLink = firstInteraction.getByRole('link', {
    name: 'Preview docs',
  });
  await previewLink.focus();
  await previewLink.press('Enter');
  expect(
    mocks.commands.filter(
      (command) =>
        command.type === 'action.invoke' &&
        command.actionId === 'ask-user.answer',
    ),
  ).toHaveLength(0);
  await firstInteraction.focus();
  await firstInteraction.press('Enter');
  await expect(
    page.getByText('Answered from this dashboard.').first(),
  ).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Cancel' })
    .dispatchEvent('click');
  await expect(page.getByText('Answered from this dashboard.')).toHaveCount(2);
  await expect
    .poll(
      () =>
        mocks.commands.filter(
          (command) =>
            command.type === 'action.invoke' &&
            command.actionId === 'ask-user.answer',
        ).length,
    )
    .toBe(1);
  await expect
    .poll(
      () =>
        mocks.commands.filter(
          (command) =>
            command.type === 'action.invoke' &&
            command.actionId === 'ask-user.cancel',
        ).length,
    )
    .toBe(1);

  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  const activity = page.getByRole('button', {
    name: /Inspecting history.*1 tool/,
  });
  await expect(activity).toBeVisible();
  await activity.click();
  await expect(page.locator('.tool-chip').getByText('read')).toBeVisible();
  await activity.click();
  await expect(page.locator('.tool-chip').getByText('read')).toHaveCount(0);
  await expect
    .poll(
      () =>
        mocks.commands.filter(
          (command) => command.actionId === 'activity-groups.set',
        ).length,
    )
    .toBe(2);

  await page.mouse.wheel(0, -100_000);
  await page.waitForTimeout(150);
  await expect(
    page.getByText('Earlier history 1', { exact: true }),
  ).toBeVisible();
  await mocks.emit({
    runtimeId: 'r1',
    event: {
      type: 'message.started',
      sessionId: 's1',
      message: {
        messageId: 'reading-live',
        role: 'user',
        content: [{ type: 'text', text: 'Live update while reading' }],
      },
    },
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollHeight -
          (window.scrollY + window.innerHeight),
      ),
    )
    .toBeGreaterThan(120);
  await page.mouse.wheel(0, 100_000);
  await expect(page.getByText('Live update while reading')).toBeVisible();
  await mocks.emit({
    type: 'snapshot',
    snapshot: phase6Snapshot({ liveState: 'working', pendingInteractions: [] }),
  });
  const deliveryMode = page.getByRole('button', {
    name: 'Steer current work instead of following up later',
  });
  await expect(deliveryMode).toHaveCount(1);
  await expect(deliveryMode).toHaveText('Later');
  await expect(deliveryMode).toHaveAttribute('aria-pressed', 'false');
  await deliveryMode.click();
  await expect(deliveryMode).toHaveText('Steer');
  await expect(deliveryMode).toHaveAttribute('aria-pressed', 'true');
  await mocks.emit({
    type: 'snapshot',
    snapshot: phase6Snapshot({ liveState: 'idle', pendingInteractions: [] }),
  });
  await expect(page.getByLabel('Message Pi')).toBeEnabled();
  await page.getByLabel('Message Pi').fill('stream this');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect
    .poll(() => mocks.commands.some((command) => command.type === 'prompt'))
    .toBe(true);
  await mocks.emit({
    runtimeId: 'r1',
    event: {
      type: 'message.started',
      sessionId: 's1',
      message: {
        messageId: 'assistant-live',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Streaming answer' },
          {
            type: 'toolCall',
            id: 'stream-tool',
            name: 'read',
            arguments: { path: 'src/live.ts' },
          },
        ],
      },
    },
  });
  await mocks.emit({
    runtimeId: 'r1',
    event: {
      type: 'tool.started',
      sessionId: 's1',
      tool: {
        toolCallId: 'stream-tool',
        name: 'read',
        arguments: { path: 'src/live.ts' },
        status: 'running',
      },
    },
  });
  await mocks.emit({
    runtimeId: 'r1',
    event: {
      type: 'tool.finished',
      sessionId: 's1',
      tool: {
        toolCallId: 'stream-tool',
        name: 'read',
        result: 'done',
        status: 'completed',
      },
    },
  });
  await mocks.emit({
    runtimeId: 'r1',
    event: {
      type: 'message.finished',
      sessionId: 's1',
      message: {
        messageId: 'assistant-live',
        role: 'assistant',
        content: [{ type: 'text', text: 'Streaming answer' }],
      },
    },
  });
  await page.mouse.wheel(0, 100_000);
  await expect(page.getByText('Streaming answer')).toBeVisible();

  await page.getByLabel('Choose images').setInputFiles({
    name: 'phase6.png',
    mimeType: 'image/png',
    buffer: Buffer.from([1, 2, 3]),
  });
  await expect(page.getByAltText('phase6.png')).toBeVisible();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect
    .poll(() => mocks.commands.some((command) => command.type === 'multipart'))
    .toBe(true);
  await page.keyboard.press('Control+K');
  await page.getByLabel('Filter actions').fill('Unsafe');
  await expect(page.getByText('No results for “Unsafe”.')).toBeVisible();
  await page.getByLabel('Filter actions').fill('Compact');
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      mocks.commands.some((command) => command.actionId === 'session.compact'),
    )
    .toBe(true);

  await mocks.close();
  await expect(page.getByRole('status')).toContainText(
    'Live updates disconnected',
  );
  await expect.poll(mocks.streamCount).toBeGreaterThan(1);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Existing session request' }),
  ).toBeVisible();
});

test('phase six mocked management flow covers refresh, fallback notification, launch, resume, and runtime lifecycle', async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.context().grantPermissions(['notifications']);
  const mocks = await installPhase6Mocks(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Refresh workspaces' }).click();
  await expect(page.getByText('Refreshed project')).toBeVisible();
  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Browser alerts' }).click();
  await expect(
    page.getByRole('button', { name: /Browser alerts on|Alerts unavailable/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: '+ Agent' }).click();
  await page.getByLabel('Resume session (optional)').selectOption('s1');
  await page
    .getByRole('button', { name: 'Start in a new tmux window' })
    .click();
  await expect(page).toHaveURL(/\/runtimes\/r-launched$/);
  expect(mocks.starts[0]).toMatchObject({ workspaceId: 'w1', sessionId: 's1' });
  await page.goto('/sessions/s1');
  await mocks.emit({
    type: 'snapshot',
    snapshot: phase6Snapshot({ pendingInteractions: [] }),
  });
  await page.locator('details.session-controls').evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  await expect(
    page.getByRole('button', { name: 'Stop', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Stop', exact: true })
    .click({ force: true });
  await page
    .getByRole('button', { name: 'Force stop', exact: true })
    .click({ force: true });
  await expect.poll(() => mocks.stops.length).toBe(2);
  await page
    .getByRole('button', { name: 'Restart', exact: true })
    .click({ force: true });
  await expect(page).toHaveURL(/\/runtimes\/r-restarted$/);
  expect(mocks.stops).toEqual([{ force: false }, { force: true }]);
  expect(mocks.restarts[0]?.id).toBeTruthy();
});
