import { expect, type Locator, type Page, test } from '@playwright/test';

async function swipe(
  target: Locator,
  { dx, dy = 0 }: { dx: number; dy?: number },
) {
  await target.evaluate(
    (element, movement) => {
      const point = (x: number, y: number) =>
        new Touch({
          identifier: 1,
          target: element,
          clientX: x,
          clientY: y,
        });
      const dispatch = (
        type: 'touchstart' | 'touchmove' | 'touchend',
        touches: Touch[],
        changedTouches: Touch[],
      ) =>
        element.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches,
            changedTouches,
          }),
        );
      const start = point(24, 180);
      const end = point(24 + movement.dx, 180 + movement.dy);
      dispatch('touchstart', [start], [start]);
      dispatch('touchmove', [end], [end]);
      dispatch('touchend', [], [end]);
    },
    { dx, dy },
  );
}

test('mobile dashboard renders and supports project-scoped new chat', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.route('**/api/usage', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/workspaces/w/composer-commands', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        commands: [
          {
            name: 'review',
            description: 'Review changes',
            argumentHint: '[scope]',
            source: 'prompt',
          },
          {
            name: 'skill:browser',
            description: 'Automate a browser',
            source: 'skill',
          },
          {
            name: 'skill:harness-feedback',
            description:
              'Capture actionable feedback about the Pi harness and its developer experience.',
            source: 'skill',
          },
        ],
      }),
    }),
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
            lastSeenAt: 20,
            model: {
              provider: 'test',
              model: 'careful',
              thinking: 'high',
              supportsImages: true,
            },
            modelCatalog: [
              { provider: 'test', model: 'fast', name: 'Fast' },
              {
                provider: 'test',
                model: 'careful',
                name: 'Careful',
                supportsImages: true,
              },
            ],
            thinkingLevels: ['off', 'medium', 'high'],
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
            path: '/Users/example/this-is-a-deliberately-long-workspace-path/with-more-segments/project',
            canonicalPath:
              '/Users/example/this-is-a-deliberately-long-workspace-path/with-more-segments/project',
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
  await expect(
    page.getByRole('heading', { name: 'No thread selected' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'No runtimes are connected. Offline and failed threads remain in the workspace nav for diagnosis.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open agent list' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open agent list' }).click();
  await expect(page.getByText('Agents', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'A deliberately long session title that must wrap safely offline',
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('complementary', { name: 'Agents and threads' })
      .getByRole('button', { name: 'New chat in Demo', exact: true }),
  ).toBeVisible();
  await page.locator('.agent-nav-backdrop').click();
  await expect(page.locator('.agent-nav-backdrop')).toHaveCount(0);
  const paletteTrigger = page.getByRole('button', {
    name: 'Open command palette',
  });
  await paletteTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toBeVisible();
  await expect(page.getByRole('option', { name: /Dashboard/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /New chat/ })).toBeVisible();
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
  await paletteTrigger.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('option', { name: /New chat/ }).click();
  const workspaceDialog = page.getByRole('dialog', { name: 'Workspaces' });
  await expect(workspaceDialog).toBeVisible();
  await workspaceDialog.getByRole('button', { name: /Demo/ }).click();
  await expect(page).toHaveURL(/\/workspaces\/w$/u);
  await page
    .locator('.section-heading')
    .getByRole('button', { name: 'New chat', exact: true })
    .click();
  expect(
    await page
      .locator('body')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await expect(page).toHaveURL(/\/workspaces\/w\/new$/u);
  await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
  const newChatComposer = page.getByRole('textbox', {
    name: 'Message Pi',
    exact: true,
  });
  await expect(newChatComposer).toBeVisible();
  await newChatComposer.fill('/rev');
  await expect(
    page.getByRole('listbox', { name: 'Available commands' }),
  ).toBeVisible();
  await expect(page.getByRole('option', { name: /\/review/ })).toBeVisible();
  await newChatComposer.press('Control+Enter');
  await expect(page.getByRole('option', { name: /\/review/ })).toBeVisible();
  await expect(newChatComposer).toContainText('/rev');
  await newChatComposer.press('Enter');
  await expect(newChatComposer).toContainText('/review');
  await expect(
    page.getByRole('listbox', { name: 'Available commands' }),
  ).toHaveCount(0);
  await newChatComposer.fill('');
  await expect(
    page.getByRole('listbox', { name: 'Available commands' }),
  ).toHaveCount(0);
  await newChatComposer.fill('/fee');
  const fuzzyMenu = page.getByRole('listbox', { name: 'Available commands' });
  await expect(
    page.getByRole('option', { name: /\/skill:harness-feedback/ }),
  ).toBeVisible();
  const fuzzyMenuWidth = await fuzzyMenu.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  expect(fuzzyMenuWidth / viewportWidth).toBeGreaterThan(0.9);
  await newChatComposer.fill('');
  const composerWidth = await page
    .locator('.new-chat-composer')
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(composerWidth / viewportWidth).toBeGreaterThan(0.8);
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(
    'test/careful',
  );
  await expect(page.getByLabel('Thinking level')).toHaveValue('high');
  await expect(
    page.getByRole('button', { name: 'Attach images' }),
  ).toBeVisible();
  await page.getByLabel('Model', { exact: true }).selectOption('test/fast');
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(
    'test/fast',
  );
  await expect(
    page.getByRole('button', { name: 'Send first message' }),
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

test('session shell shows compaction progress', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('pi-dashboard-token', 'test-token'),
  );
  await page.route('**/api/usage', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/events?*', async (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: ': heartbeat\n\n',
    }),
  );
  let cancellationCommand: unknown;
  await page.route(
    '**/api/runtimes/runtime-compacting/command',
    async (route) => {
      cancellationCommand = route.request().postDataJSON();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ accepted: true }),
      });
    },
  );
  const runtime = {
    runtimeId: 'runtime-compacting',
    ownership: 'external',
    pid: 1,
    cwd: '/tmp',
    liveState: 'compacting',
    online: true,
    session: {
      id: 'session-compacting',
      title: 'Compacting session',
      entries: [],
      entriesComplete: true,
    },
    pendingInteractions: [],
  };
  const metadata = {
    id: 'session-compacting',
    file: '',
    cwd: '/tmp',
    title: 'Compacting session',
    updatedAt: Date.now(),
  };
  await page.route('**/api/snapshot', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        serverId: 'server-compacting',
        revision: 1,
        cursor: 0,
        runtimes: [runtime],
        workspaces: [],
        sessions: [metadata],
        unread: [],
      }),
    }),
  );
  await page.route('**/api/sessions/session-compacting', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        serverId: 'server-compacting',
        cursor: 0,
        runtimeEpoch: 'epoch-compacting',
        runtimeSeq: 1,
        metadata,
        entries: [],
        entriesComplete: true,
      }),
    }),
  );

  await page.goto('/sessions/session-compacting');

  await expect(page.locator('.session-status')).toHaveText(/compacting/i);
  const compactionEvent = page.locator('.live-compaction-event');
  await expect(compactionEvent).toContainText('Compacting context…');
  await expect(compactionEvent).toContainText('in progress');
  await expect(page.locator('.composer')).toContainText('Compacting context…');
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();

  await page.getByRole('button', { name: 'Cancel context compaction' }).click();
  await expect
    .poll(() => cancellationCommand)
    .toMatchObject({
      type: 'compact.cancel',
    });
});

test('session shell exposes timestamps, dormant state, and persistent drafts', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('pi-dashboard-token', 'test-token'),
  );
  await page.route('**/api/usage', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/events?*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      contentType: 'text/event-stream',
      body: ': heartbeat\n\n',
    });
  });
  await page.route('**/api/snapshot', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        serverId: 'server-loading',
        revision: 1,
        cursor: 0,
        runtimes: [
          {
            runtimeId: 'runtime-loading',
            ownership: 'external',
            pid: 1,
            cwd: '/tmp',
            liveState: 'idle',
            online: true,
            session: {
              id: 'session-loading',
              title: 'Loaded shell',
              entries: [],
            },
            pendingInteractions: [],
          },
        ],
        workspaces: [],
        sessions: [
          {
            id: 'session-loading',
            file: '',
            cwd: '/tmp',
            title: 'Loaded shell',
            updatedAt: Date.parse('2026-08-05T18:42:00.000Z'),
          },
          {
            id: 'session-dormant',
            file: '',
            cwd: '/tmp/archive',
            title: 'Dormant thread',
            updatedAt: Date.parse('2026-08-04T12:00:00.000Z'),
          },
        ],
        unread: [],
      }),
    }),
  );
  await page.route('**/api/sessions/session-dormant', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        serverId: 'server-loading',
        cursor: 0,
        metadata: {
          id: 'session-dormant',
          file: '',
          cwd: '/tmp/archive',
          title: 'Dormant thread',
          updatedAt: Date.parse('2026-08-04T12:00:00.000Z'),
        },
        entries: [
          ...Array.from({ length: 80 }, (_, index) => ({
            type: 'message',
            message: {
              id: `dormant-history-${index}`,
              role: 'user',
              content: `Dormant history ${index}`,
              timestamp: Date.parse('2026-08-04T10:00:00.000Z') + index,
            },
          })),
          {
            type: 'message',
            message: {
              id: 'dormant-history-latest',
              role: 'user',
              content: 'Dormant latest',
              timestamp: Date.parse('2026-08-04T11:00:00.000Z'),
            },
          },
        ],
      }),
    }),
  );
  await page.route('**/api/sessions/session-loading', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        serverId: 'server-loading',
        cursor: 0,
        metadata: {
          id: 'session-loading',
          file: '',
          cwd: '/tmp',
          title: 'Loaded shell',
          updatedAt: 1,
        },
        entries: [
          ...Array.from({ length: 80 }, (_, index) => ({
            type: 'message',
            message: {
              id: `history-${index}`,
              role: 'user',
              content: `Earlier history ${index}`,
              timestamp: Date.parse('2026-08-05T17:00:00.000Z') + index,
            },
          })),
          {
            type: 'message',
            message: {
              id: 'history-latest',
              role: 'user',
              content: 'Prior history',
              timestamp: '2026-08-05T18:42:00.000Z',
            },
          },
        ],
      }),
    });
  });

  await page.goto('/sessions/session-loading');
  await expect(page.locator('.session-heading h1')).toHaveText('Loaded shell');
  await expect(page.locator('.session-transcript-loading')).toContainText(
    'Loading session…',
  );
  await expect(
    page.getByRole('button', { name: 'Open agent list' }),
  ).toBeVisible();
  await expect(page.getByRole('form', { name: 'Send a message' })).toHaveCount(
    0,
  );
  const notice = page.locator('.sync-notice');
  await expect(notice).toContainText('Connecting to live updates…');
  expect(
    await notice.evaluate((element) => ({
      position: getComputedStyle(element).position,
      insideMain: Boolean(element.closest('main')),
    })),
  ).toEqual({ position: 'fixed', insideMain: false });
  await expect(page.locator('.transcript-virtualized')).toContainText(
    'Prior history',
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollHeight -
          (window.scrollY + window.innerHeight),
      ),
    )
    .toBeLessThanOrEqual(1);
  await expect(
    page
      .getByRole('article')
      .filter({ hasText: 'Prior history' })
      .getByRole('time'),
  ).toHaveAttribute('datetime', '2026-08-05T18:42:00.000Z');
  await page.getByRole('button', { name: 'Open transcript outline' }).click();
  const outline = page.getByRole('dialog', { name: 'Transcript outline' });
  await expect(outline).toHaveClass(/work-surface-dialog/);
  await expect(outline.locator('h2')).toHaveCount(0);
  await expect(outline.locator('.eyebrow')).toHaveText('Transcript outline');
  await expect(outline.locator('.surface-dialog-summary')).toContainText(
    'Navigate transcript landmarks',
  );
  await expect(outline.locator('.surface-stats')).toContainText('landmarks');
  expect(
    await outline
      .locator('.surface-dialog-body')
      .evaluate((element) => getComputedStyle(element).padding),
  ).toBe('0px');
  await expect(
    outline.locator('.transcript-outline-time').first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close Transcript outline' }).click();

  await page.getByRole('button', { name: 'Open agent list' }).click();
  const agentNav = page.getByRole('complementary', {
    name: 'Agents and threads',
  });
  await expect(
    agentNav.getByRole('button', { name: 'Loaded shell idle' }),
  ).toBeVisible();
  await expect(
    agentNav.getByRole('button', { name: 'Dormant thread dormant' }),
  ).toBeVisible();
  await expect(
    agentNav.locator('.agent-thread-row.status-idle .agent-thread-glyph'),
  ).toHaveText('●');
  await expect(
    agentNav.locator('.agent-thread-row.status-dormant .agent-thread-glyph'),
  ).toHaveText('◌');
  const idleMarker = await agentNav
    .locator('.agent-thread-row.status-idle .agent-thread-glyph')
    .evaluate((element) => {
      const marker = getComputedStyle(element, '::before');
      return {
        width: marker.width,
        height: marker.height,
        background: marker.backgroundColor,
      };
    });
  const dormantMarker = await agentNav
    .locator('.agent-thread-row.status-dormant .agent-thread-glyph')
    .evaluate((element) => {
      const marker = getComputedStyle(element, '::before');
      return {
        width: marker.width,
        height: marker.height,
        borderStyle: marker.borderStyle,
      };
    });
  expect(idleMarker).toMatchObject({ width: '8px', height: '8px' });
  expect(idleMarker.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(dormantMarker).toEqual({
    width: '8px',
    height: '8px',
    borderStyle: 'dotted',
  });
  await expect(agentNav.locator('.agent-thread-time')).toHaveCount(2);
  await page.locator('.agent-nav-backdrop').click();

  const composer = page.getByLabel('Message Pi');
  await expect(composer).toBeVisible();
  await composer.fill('Draft survives navigation and refresh');
  await page.evaluate(() => {
    window.dispatchEvent(new WheelEvent('wheel'));
    window.scrollTo(0, 0);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.getByRole('button', { name: 'Open agent list' }).click();
  await page
    .getByRole('complementary', { name: 'Agents and threads' })
    .getByRole('button', { name: 'Dormant thread dormant' })
    .click();
  await expect(page).toHaveURL(/\/sessions\/session-dormant$/u);
  await expect(page.getByText('This session is dormant.')).toBeVisible();
  await expect(page.getByText('Dormant latest')).toBeVisible();
  await expect(page.locator('.session-page')).not.toHaveAttribute(
    'data-tail-pending',
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollHeight -
          (window.scrollY + window.innerHeight),
      ),
    )
    .toBeLessThanOrEqual(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem('pi-dashboard-composer-draft:session-loading'),
      ),
    )
    .toBe('Draft survives navigation and refresh');
  await page.getByRole('button', { name: 'Open agent list' }).click();
  await page
    .getByRole('complementary', { name: 'Agents and threads' })
    .getByRole('button', { name: 'Loaded shell idle' })
    .click();
  await expect(page).toHaveURL(/\/sessions\/session-loading$/u);
  await expect(page.getByLabel('Message Pi')).toContainText(
    'Draft survives navigation and refresh',
  );

  await page.reload();
  await expect(page.getByLabel('Message Pi')).toContainText(
    'Draft survives navigation and refresh',
  );
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
  await expect(
    page.getByRole('heading', { name: 'No thread selected' }),
  ).toBeVisible();
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
  await expect(
    page.getByRole('heading', { name: 'No thread selected' }),
  ).toBeVisible();
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
  await expect(
    page.getByRole('heading', { name: 'No thread selected' }),
  ).toBeVisible();
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
            type: 'compaction',
            summary: '## Compaction checkpoint\nPreserved the dashboard task.',
            tokensBefore: 232_000,
          },
          {
            type: 'custom',
            customType: 'lean-todo',
            data: {
              kind: 'snapshot',
              state: {
                tasks: [{ id: 'T1', text: 'Verify dashboard', status: 'todo' }],
              },
            },
          },
          {
            type: 'custom',
            customType: 'lean-todo',
            data: {
              kind: 'snapshot',
              state: {
                tasks: [
                  { id: 'T1', text: 'Verify dashboard', status: 'doing' },
                ],
              },
            },
          },
          {
            type: 'model_change',
            provider: 'openai',
            modelId: 'gpt-5.6-sol',
          },
          { type: 'thinking_level_change', thinkingLevel: 'medium' },
          {
            type: 'custom_message',
            customType: 'delegate-job-result',
            display: true,
            content: '# Background delegate job dj-1 (UX audit) success',
            details: { jobs: [{ name: 'UX audit', state: 'success' }] },
          },
          {
            type: 'custom_message',
            customType: 'background-terminal-result',
            display: true,
            content: 'Background build completed.',
            details: {
              title: 'Dashboard build',
              status: 'done',
              exitCode: 0,
              duration: 2400,
            },
          },
          {
            type: 'custom',
            customType: 'artifact:v1',
            data: { bytes: 12 },
          },
          {
            type: 'custom_message',
            customType: 'private-context',
            display: false,
            content: 'Do not render this context.',
          },
          {
            type: 'message',
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'Focus on mobile readability.' }],
              timestamp: 100,
            },
          },
          {
            type: 'custom',
            customType: 'steering-message',
            data: { timestamp: 100, text: 'Focus on mobile readability.' },
          },
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
              timestamp: '2026-08-09T12:34:00.000Z',
              content: [
                {
                  type: 'thinking',
                  thinking: 'Checking the available mobile width.',
                },
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
                { type: 'text', text: 'Checking the failed command.' },
                {
                  type: 'toolCall',
                  id: 'call-2',
                  name: 'bash',
                  arguments: { command: 'false' },
                },
              ],
            },
          },
          {
            type: 'message',
            message: {
              role: 'toolResult',
              toolCallId: 'call-2',
              content: [{ type: 'text', text: 'Command failed' }],
              isError: true,
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
                {
                  type: 'text',
                  text: 'Deployment resumes automatically.',
                },
              ],
            },
          },
        ],
      }),
    });
  });
  await page.goto('/sessions/s1');
  const steeringMessage = page.locator('.message-steering');
  await expect(steeringMessage).toContainText('Focus on mobile readability.');
  await expect(steeringMessage.locator('.message-role')).toHaveText('steer');
  await expect(steeringMessage.locator('.message-delivery-mode')).toHaveCount(
    0,
  );
  const steeringColors = await steeringMessage.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    border: getComputedStyle(element).borderLeftColor,
  }));
  const ordinaryUserBackground = await page
    .locator('.message-user:not(.message-steering)')
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(steeringColors.background).toBe(ordinaryUserBackground);
  expect(steeringColors.border).not.toBe(steeringColors.background);
  await expect(page.getByText('Check', { exact: true })).toBeVisible();
  const userLink = page.getByRole('link', { name: 'dashboard' });
  await expect(userLink).toHaveAttribute('href', 'https://example.com');
  await expect(userLink).toHaveAttribute('target', '_blank');
  await expect(page.locator('.session-status')).toContainText('ready');
  const compactHeader = await page
    .locator('.session-heading')
    .evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      text: element.textContent ?? '',
    }));
  expect(compactHeader.height).toBeGreaterThanOrEqual(44);
  expect(compactHeader.height).toBeLessThanOrEqual(52);
  expect(compactHeader.text).not.toContain('/tmp');
  expect(compactHeader.text).not.toContain('test/');
  await expect(page.getByText('inline code', { exact: true })).toBeVisible();
  await expect(page.locator('.message-assistant .message-role')).toHaveText(
    'agent',
  );
  await expect(page.locator('.activity-step-time')).toBeVisible();
  const fullWidthGeometry = await page.evaluate(() => {
    const transcript = document.querySelector('.transcript');
    const message = document.querySelector('.message-bubble');
    const composer = document.querySelector('.composer');
    if (!transcript || !message || !composer)
      throw new Error('Transcript surfaces missing');
    return {
      transcript: transcript.getBoundingClientRect().width,
      message: message.getBoundingClientRect().width,
      composer: composer.getBoundingClientRect().width,
    };
  });
  expect(
    Math.abs(fullWidthGeometry.message - fullWidthGeometry.transcript),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(fullWidthGeometry.composer - fullWidthGeometry.transcript),
  ).toBeLessThanOrEqual(1);
  const finalAssistantParagraphs = page
    .locator('.message-assistant')
    .filter({ hasText: 'Deployment resumes automatically.' })
    .locator('.markdown > p');
  await expect(finalAssistantParagraphs).toHaveCount(2);
  const paragraphBoxes = await finalAssistantParagraphs.evaluateAll(
    (paragraphs) =>
      paragraphs.map((paragraph) => {
        const bounds = paragraph.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom };
      }),
  );
  expect(paragraphBoxes[1]?.top).toBeGreaterThan(
    paragraphBoxes[0]?.bottom ?? 0,
  );
  await expect(
    page.getByText('Context compacted', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('232K tokens', { exact: true })).toBeVisible();
  await expect(page.getByText(/Tasks · T1 added · 1 waiting/)).toBeVisible();
  await expect(page.getByText(/Tasks · T1 started · 1 active/)).toBeVisible();
  await expect(
    page.getByText('Model → openai/gpt-5.6-sol · thinking medium'),
  ).toBeVisible();
  await expect(page.getByText('Delegate finished · UX audit')).toBeVisible();
  await expect(
    page.getByText(/Background command finished · Dashboard build · 2s/),
  ).toBeVisible();
  await expect(page.getByText('artifact:v1')).toHaveCount(0);
  await expect(page.getByText('Do not render this context.')).toHaveCount(0);
  await page.getByText('Context compacted', { exact: true }).click();
  await expect(page.getByText('Compaction checkpoint')).toBeVisible();
  await page.evaluate(() => {
    const target = document;
    if (!document.querySelector('.agent-nav-handle'))
      throw new Error('agent drawer handle missing');
    const touch = (type: string, x: number) =>
      target.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          changedTouches: [
            new Touch({
              identifier: 1,
              target,
              clientX: x,
              clientY: 300,
            }),
          ],
        }),
      );
    touch('touchstart', 2);
    touch('touchend', 86);
  });
  await expect(page.locator('.agent-nav-drawer.open')).toBeVisible();
  const threadRow = page
    .locator('.agent-nav-drawer.open .agent-thread-row')
    .first();
  const threadCopyRightGap = await threadRow.evaluate((row) => {
    const copy = row.querySelector('.agent-thread-copy');
    if (!copy) throw new Error('Agent thread copy missing');
    return (
      row.getBoundingClientRect().right - copy.getBoundingClientRect().right
    );
  });
  expect(threadCopyRightGap).toBeLessThanOrEqual(8);
  await threadRow.click();
  await expect(page.locator('.agent-nav-drawer.open')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open transcript outline' }).click();
  const outline = page.getByRole('dialog', { name: 'Transcript outline' });
  await expect(outline).toBeVisible();
  await swipe(outline, { dx: 44 });
  await expect(outline).toBeVisible();
  await swipe(outline, { dx: 104, dy: 8 });
  await expect(outline).toHaveCount(0);
  await page.getByRole('button', { name: 'Open transcript outline' }).click();
  const reopenedOutline = page.getByRole('dialog', {
    name: 'Transcript outline',
  });
  const steeringOutlineItem = reopenedOutline.getByRole('button', {
    name: /^Steering · Focus on mobile readability\./u,
  });
  await expect(steeringOutlineItem).toHaveClass(/outline-steering/u);
  await reopenedOutline
    .getByRole('button', { name: 'Earlier message 1', exact: true })
    .click();
  await expect(reopenedOutline).toHaveCount(0);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    window.dispatchEvent(new Event('scroll'));
  });
  const jumpLatest = page.getByRole('button', {
    name: 'Jump to latest transcript activity',
  });
  await expect(jumpLatest).toBeVisible();
  const jumpGeometry = await jumpLatest.evaluate((button) => {
    const buttonRect = button.getBoundingClientRect();
    const composerRect = document
      .querySelector('.composer')
      ?.getBoundingClientRect();
    return {
      width: buttonRect.width,
      height: buttonRect.height,
      rightGap: window.innerWidth - buttonRect.right,
      bottom: buttonRect.bottom,
      composerTop: composerRect?.top,
      borderRadius: getComputedStyle(button).borderRadius,
    };
  });
  expect(jumpGeometry.borderRadius).toBe('50%');
  expect(jumpGeometry.width).toBeCloseTo(48, 1);
  expect(jumpGeometry.height).toBeCloseTo(48, 1);
  expect(jumpGeometry.rightGap).toBeCloseTo(13, 1);
  expect(jumpGeometry.bottom).toBeLessThan(jumpGeometry.composerTop ?? 0);
  await jumpLatest.click();
  await expect(jumpLatest).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollHeight -
          (window.scrollY + window.innerHeight),
      ),
    )
    .toBeLessThanOrEqual(1);
  const failedActivity = page.getByRole('button', {
    name: /Checking the failed command.*1 tool.*failed/,
  });
  await expect(failedActivity).toBeVisible();
  await failedActivity.click();
  const failedExpandedDot = failedActivity
    .locator('xpath=..')
    .locator('.tool-detail.step-failed .activity-step-dot');
  await expect(failedExpandedDot).toHaveText('!');
  await failedActivity.click();
  const activity = page.getByRole('button', {
    name: /Checking the mobile transcript.*1 tool/,
  });
  await expect(activity).toBeVisible();
  const mobileActivityHeader = await activity.evaluate((button) => {
    const icon = button
      .querySelector('.activity-icon')
      ?.getBoundingClientRect();
    const title = button.querySelector('strong')?.getBoundingClientRect();
    return icon && title
      ? {
          topDifference: Math.abs(icon.top - title.top),
          gap: title.left - icon.right,
        }
      : undefined;
  });
  expect(mobileActivityHeader?.topDifference).toBeLessThan(5);
  expect(mobileActivityHeader?.gap).toBeGreaterThanOrEqual(0);
  await expect(activity.locator('small')).toBeHidden();
  await expect(
    activity.locator('xpath=..').getByText('1 tool call', { exact: true }),
  ).toHaveCount(1);
  const completedStepDot = activity
    .locator('xpath=..')
    .locator('.activity-step.step-complete .activity-step-dot');
  await expect(completedStepDot).toHaveText('');
  const completedMarkerStyle = await completedStepDot.evaluate((dot) => {
    const marker = getComputedStyle(dot, '::before');
    return {
      width: marker.width,
      height: marker.height,
      borderRadius: marker.borderRadius,
      backgroundColor: marker.backgroundColor,
    };
  });
  expect(completedMarkerStyle).toMatchObject({
    width: '6px',
    height: '6px',
    borderRadius: '50%',
  });
  expect(completedMarkerStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
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
  await expect
    .poll(() =>
      page.evaluate(() => {
        const layer = document.querySelector('.session-control-layer');
        const sessionPage = document.querySelector('.session-page');
        if (!layer || !sessionPage) return 0;
        return (
          Number.parseFloat(getComputedStyle(sessionPage).paddingBottom) -
          layer.getBoundingClientRect().height
        );
      }),
    )
    .toBeGreaterThanOrEqual(13);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollHeight -
          (window.scrollY + window.innerHeight),
      ),
    )
    .toBeLessThanOrEqual(1);
  const attachmentLayout = await page.evaluate(() => {
    const composer = document.querySelector('.composer');
    const previews = document.querySelector('.composer-previews');
    const controlLayer = document.querySelector('.session-control-layer');
    const sessionPage = document.querySelector('.session-page');
    if (!composer || !previews || !controlLayer || !sessionPage)
      throw new Error('Composer layout not found');
    const composerRect = composer.getBoundingClientRect();
    const previewsRect = previews.getBoundingClientRect();
    return {
      composerHeight: composerRect.height,
      previewsTop: previewsRect.top,
      previewsBottom: previewsRect.bottom,
      composerTop: composerRect.top,
      composerBottom: composerRect.bottom,
      controlHeight: controlLayer.getBoundingClientRect().height,
      controlTop: controlLayer.getBoundingClientRect().top,
      transcriptTailBottom: Array.from(
        document.querySelectorAll<HTMLElement>(
          '.transcript [data-transcript-row]',
        ),
      )
        .at(-1)
        ?.getBoundingClientRect().bottom,
      pagePaddingBottom: Number.parseFloat(
        getComputedStyle(sessionPage).paddingBottom,
      ),
    };
  });
  expect(attachmentLayout.composerHeight).toBeGreaterThan(
    composerHeightBeforeAttachment,
  );
  expect(attachmentLayout.previewsTop).toBeGreaterThanOrEqual(
    attachmentLayout.composerTop,
  );
  expect(attachmentLayout.previewsBottom).toBeLessThanOrEqual(
    attachmentLayout.composerBottom,
  );
  expect(attachmentLayout.pagePaddingBottom).toBeGreaterThanOrEqual(
    attachmentLayout.controlHeight + 13,
  );
  expect(attachmentLayout.pagePaddingBottom).toBeLessThanOrEqual(
    attachmentLayout.controlHeight + 16,
  );
  expect(attachmentLayout.transcriptTailBottom).toBeLessThanOrEqual(
    attachmentLayout.controlTop,
  );
  expect(
    attachmentLayout.controlTop -
      (attachmentLayout.transcriptTailBottom ?? attachmentLayout.controlTop),
  ).toBeLessThanOrEqual(8);
  await page.getByRole('button', { name: 'Remove picker.png' }).click();
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array([1])], 'paste.webp', { type: 'image/webp' }),
    );
    document.querySelector('[contenteditable="true"]')?.dispatchEvent(
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
  expect(await page.locator('.mobile-bottom-nav')).toHaveCount(0);
  const composerViewportLayout = await page.evaluate(() => {
    const composer = document
      .querySelector('.composer')
      ?.getBoundingClientRect();
    return composer
      ? { bottom: composer.bottom, viewport: window.innerHeight }
      : undefined;
  });
  expect(composerViewportLayout?.bottom).toBeLessThanOrEqual(
    (composerViewportLayout?.viewport ?? 0) + 1,
  );
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('Visual Viewport unavailable');
    Object.defineProperty(viewport, 'height', {
      configurable: true,
      value: window.innerHeight - 240,
    });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect
    .poll(() =>
      page
        .locator('.session-page')
        .evaluate((element) =>
          Number.parseFloat(
            getComputedStyle(element).getPropertyValue('--keyboard-inset'),
          ),
        ),
    )
    .toBe(240);
  const keyboardComposerBottom = await page
    .locator('.composer')
    .evaluate((element) => element.getBoundingClientRect().bottom);
  const keyboardVisibleBottom = (composerViewportLayout?.viewport ?? 0) - 240;
  expect(keyboardComposerBottom).toBeLessThanOrEqual(keyboardVisibleBottom);
  expect(keyboardVisibleBottom - keyboardComposerBottom).toBeLessThanOrEqual(1);
  const keyboardScrollY = await page.evaluate(() => {
    window.scrollBy(0, -48);
    window.visualViewport?.dispatchEvent(new Event('scroll'));
    return window.scrollY;
  });
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => window.scrollY)).toBe(keyboardScrollY);
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    Reflect.deleteProperty(viewport, 'height');
    viewport.dispatchEvent(new Event('resize'));
  });
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  const mobileInspector = page.getByRole('dialog');
  await expect(mobileInspector).toBeVisible();
  const mobileInspectorGeometry = await page.evaluate(() => {
    const inspector = document
      .querySelector('.session-inspector')
      ?.getBoundingClientRect();
    return inspector
      ? {
          top: inspector.top,
          bottom: inspector.bottom,
          viewport: window.innerHeight,
        }
      : undefined;
  });
  expect(mobileInspectorGeometry?.top).toBeGreaterThanOrEqual(0);
  expect(mobileInspectorGeometry?.bottom).toBeLessThanOrEqual(
    mobileInspectorGeometry?.viewport ?? 0,
  );
  await page.keyboard.press('Escape');
  await expect(mobileInspector).toHaveCount(0);
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect(activity).toBeVisible();
  await activity.click();
  const expandedAction = page.locator('.tool-detail > summary.activity-step');
  await expect(
    expandedAction.locator('.activity-tool-name').getByText('Reading'),
  ).toBeVisible();
  const expandedStepDot = expandedAction.locator('.activity-step-dot');
  await expect(expandedStepDot).toBeVisible();
  expect(
    await expandedStepDot.evaluate(
      (dot) => getComputedStyle(dot, '::before').backgroundColor,
    ),
  ).not.toBe('rgba(0, 0, 0, 0)');
  const thinkingTime = page.locator('.thinking-time');
  await expect(thinkingTime).toBeVisible();
  const thinkingLayout = await thinkingTime.evaluate((time) => {
    const blob = time.closest('.transcript-thinking-blob');
    const firstParagraph = blob?.querySelector('.markdown > p');
    if (!blob || !firstParagraph) throw new Error('Thinking layout missing');
    const timeRect = time.getBoundingClientRect();
    const blobRect = blob.getBoundingClientRect();
    const paragraphRect = firstParagraph.getBoundingClientRect();
    return {
      topDifference: Math.abs(timeRect.top - paragraphRect.top),
      paragraphTopInset: paragraphRect.top - blobRect.top,
      blobBackgroundImage: getComputedStyle(blob).backgroundImage,
      timestampBackgroundImage: getComputedStyle(time).backgroundImage,
    };
  });
  expect(thinkingLayout.topDifference).toBeLessThanOrEqual(2);
  expect(thinkingLayout.paragraphTopInset).toBeLessThanOrEqual(8);
  expect(thinkingLayout.blobBackgroundImage).toContain('linear-gradient');
  expect(thinkingLayout.timestampBackgroundImage).toBe('none');
  const timestampRights = await page
    .locator('.activity-group .transcript-time:visible')
    .evaluateAll((timestamps) =>
      timestamps.map((timestamp) => timestamp.getBoundingClientRect().right),
    );
  expect(timestampRights.length).toBeGreaterThanOrEqual(4);
  expect(
    Math.max(...timestampRights) - Math.min(...timestampRights),
  ).toBeLessThanOrEqual(1);
  await expect(page.getByText('src/App.tsx', { exact: true })).toBeVisible();
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
  ).toBeHidden();
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
  await expect(
    page.locator('.message-bubble').getByText('Live dashboard message'),
  ).toHaveCount(1);
  // Reload while the authenticated stream is active; the session baseline and
  // transcript projection must hydrate without relying on the old page state.
  await page.reload();
  await expect(page.locator('.session-status')).toContainText('ready');
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
  await expect(
    page.locator('.message-bubble').getByText('Live dashboard message'),
  ).toHaveCount(1);
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
  await expect(
    page.locator('.message-bubble').getByText('Delta during settled turn'),
  ).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 }));
    window.scrollBy(0, -400);
  });
  await emitMessage('message.started', 456, 'Message while reading history');
  await expect(
    page.locator('.message-bubble').getByText('Message while reading history'),
  ).toHaveCount(1);
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
      { id: 'runtime.pause-control', version: '1', available: true },
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
        id: 'pause',
        version: '1',
        actions: [
          {
            id: 'runtime.pause',
            title: 'Pause runtime',
            inputSchema: phase6ActionSchema,
            availability: {
              requires: ['runtime.pause-control'],
              liveStates: ['idle', 'working', 'waiting'],
            },
          },
          {
            id: 'runtime.continue',
            title: 'Continue runtime',
            inputSchema: phase6ActionSchema,
            availability: {
              requires: ['runtime.pause-control'],
              liveStates: ['idle', 'working', 'waiting'],
            },
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
        timestamp: Date.UTC(2026, 7, 5, 18, index),
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
          { type: 'thinking', thinking: '**Considering the workspace**' },
          { type: 'text', text: 'Inspecting history' },
          {
            type: 'toolCall',
            id: 'history-read',
            name: 'read',
            arguments: { path: '/tmp/project/src/App.tsx' },
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
    extensionSurfaces?: unknown[];
    runtimes?: unknown[];
  } = {},
) {
  return {
    serverId: 'phase-six',
    revision: 1,
    cursor: 1,
    runtimes: overrides.runtimes ?? [
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
        ...(overrides.extensionSurfaces
          ? { extensionSurfaces: overrides.extensionSurfaces }
          : {}),
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
  await page.route('**/api/workspaces/*/composer-commands', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        commands: [
          {
            name: 'compact',
            description: 'Compact the current session',
            source: 'builtin',
          },
          {
            name: 'review',
            description: 'Review changes',
            source: 'prompt',
          },
          {
            name: 'skill:browser',
            description: 'Automate a browser',
            source: 'skill',
          },
        ],
      }),
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
  await expect(page.locator('.session-heading h1')).toHaveText(
    'Existing session request',
  );
  await mocks.emit({ type: 'snapshot', snapshot: phase6Snapshot() });
  await expect(page.getByLabel('Model')).toHaveValue('test/vision');
  await page.getByLabel('Model').selectOption('test/text');
  await expect
    .poll(() => mocks.commands.filter((command) => command.type === 'setModel'))
    .toEqual([
      expect.objectContaining({
        type: 'setModel',
        provider: 'test',
        model: 'text',
      }),
    ]);
  await expect(page.locator('.session-heading')).toContainText('Project');
  await expect(page.locator('.session-heading')).not.toContainText(
    'test/vision',
  );
  await expect(page.locator('.session-details-trigger')).toBeDisabled();
  await page.keyboard.press('Control+K');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toHaveCount(0);
  await page.getByLabel('Thinking level').selectOption('high');
  await expect
    .poll(
      () =>
        mocks.commands.filter((command) => command.type === 'setThinking')
          .length,
    )
    .toBe(1);

  const pendingDialog = page.getByRole('dialog', {
    name: 'Pending questions',
  });
  await expect(pendingDialog).toHaveCount(1);
  await expect(page.locator('.session-heading')).toBeHidden();
  await expect(pendingDialog).toHaveAttribute('aria-modal', 'true');
  const firstInteraction = page.getByRole('group', {
    name: 'Use the first answer?',
  });
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
  await pendingDialog
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
  await mocks.emit({
    type: 'snapshot',
    snapshot: phase6Snapshot({ pendingInteractions: [] }),
  });
  await expect(pendingDialog).toHaveCount(0);
  await expect(page.locator('.session-heading')).toBeVisible();

  const dockMarker = page.locator(
    '.transcript-minimap-marker[data-preview="Earlier history 1"]',
  );
  await expect(dockMarker).toHaveCount(1);
  await expect(dockMarker).toHaveAttribute('aria-label', 'Earlier history 1');
  await expect(dockMarker).not.toHaveAttribute('title', 'Earlier history 1');
  const supportsOutlineHover = await page.evaluate(
    () => window.matchMedia('(pointer: fine) and (min-width: 821px)').matches,
  );
  if (supportsOutlineHover) {
    await dockMarker.hover();
    const outlinePreview = dockMarker.locator('.transcript-minimap-preview');
    await expect(outlinePreview).toBeVisible();
    await expect(outlinePreview).toHaveAttribute(
      'data-meta',
      /User message · .+/u,
    );
    await expect(outlinePreview).toHaveAttribute(
      'data-label',
      'Earlier history 1',
    );
    const outlineGeometry = await dockMarker.evaluate((marker) => {
      const preview = marker.querySelector<HTMLElement>(
        '.transcript-minimap-preview',
      );
      const markerBox = marker.getBoundingClientRect();
      return {
        markerWidth: markerBox.width,
        previewDoesNotCapturePointer: preview
          ? getComputedStyle(preview).pointerEvents === 'none'
          : false,
        stackLevel: Number(
          getComputedStyle(marker.closest('.transcript-minimap') as Element)
            .zIndex,
        ),
        wraps: preview
          ? getComputedStyle(preview).whiteSpace === 'normal'
          : false,
      };
    });
    expect(outlineGeometry).toMatchObject({
      markerWidth: 64,
      previewDoesNotCapturePointer: true,
      stackLevel: 30,
      wraps: true,
    });
  }

  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  const activity = page.getByRole('button', {
    name: /Inspecting history.*1 tool/,
  });
  await expect(activity).toBeVisible();
  await expect(
    activity.locator('xpath=..').getByText('Reading', { exact: true }),
  ).toBeVisible();
  await expect(
    activity.locator('xpath=..').getByText('src/App.tsx', { exact: true }),
  ).toBeVisible();
  await expect(
    activity
      .locator('xpath=..')
      .getByText('/tmp/project/src/App.tsx', { exact: true }),
  ).toHaveCount(0);
  await activity.click();
  await expect(
    page
      .locator('.transcript-thinking-blob')
      .getByText('Considering the workspace'),
  ).toBeVisible();
  const expandedToolDetail = page
    .locator('.tool-detail .activity-step')
    .getByText('Reading', { exact: true });
  await expect(expandedToolDetail).toBeVisible();
  await activity.click();
  await expect(expandedToolDetail).toHaveCount(0);
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
    page.getByRole('paragraph').filter({ hasText: /^Earlier history 1$/u }),
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
  await expect(deliveryMode).toHaveText('Steer');
  await expect(deliveryMode).toHaveAttribute('aria-pressed', 'true');
  const workingComposerInput = page.getByLabel('Message Pi');
  await workingComposerInput.fill('/compact');
  await expect(
    page.getByRole('listbox', { name: 'Available commands' }),
  ).toHaveCount(0);
  await workingComposerInput.fill('');
  await deliveryMode.click();
  await expect(deliveryMode).toHaveText('Later');
  await expect(deliveryMode).toHaveAttribute('aria-pressed', 'false');
  await mocks.emit({
    type: 'snapshot',
    snapshot: phase6Snapshot({ liveState: 'idle', pendingInteractions: [] }),
  });
  const composerInput = page.getByLabel('Message Pi');
  await expect(composerInput).toBeEnabled();
  await composerInput.fill('/skill:');
  await expect(
    page.getByRole('option', { name: /\/skill:browser/ }),
  ).toBeVisible();
  await composerInput.press('Tab');
  await expect(composerInput).toContainText('/skill:browser');
  await expect(
    page.getByRole('listbox', { name: 'Available commands' }),
  ).toHaveCount(0);
  await composerInput.fill('');
  const initialComposerHeight = await composerInput.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await composerInput.fill(
    Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n'),
  );
  const grownComposerHeight = await composerInput.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(grownComposerHeight).toBeGreaterThan(initialComposerHeight);
  expect(grownComposerHeight).toBeLessThanOrEqual(180);
  await composerInput.fill(
    Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n'),
  );
  const cappedComposer = await composerInput.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    scrollHeight: element.scrollHeight,
  }));
  expect(cappedComposer.height).toBeLessThanOrEqual(180);
  expect(cappedComposer.scrollHeight).toBeGreaterThan(cappedComposer.height);
  await composerInput.fill('');
  await composerInput.pressSequentially('# ');
  await composerInput.pressSequentially('Live markdown heading');
  await expect(
    page
      .locator('.composer-rich-editor')
      .getByRole('heading', { name: 'Live markdown heading' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Preview', exact: true }),
  ).toHaveCount(0);
  await page.mouse.wheel(0, -100_000);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollHeight -
          (window.scrollY + window.innerHeight),
      ),
    )
    .toBeGreaterThan(120);
  await composerInput.fill('stream this');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollHeight -
          (window.scrollY + window.innerHeight),
      ),
    )
    .toBeLessThanOrEqual(1);
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
  await expect(page.locator('.session-heading h1')).toHaveText(
    'Existing session request',
  );
});

test('phase six mocked workspace flow covers refresh, fallback notification, agent launch, and runtime lifecycle', async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.context().grantPermissions(['notifications']);
  const mocks = await installPhase6Mocks(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open agent list' }).click();
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page
    .getByRole('dialog', { name: 'Workspaces' })
    .getByRole('button', { name: 'Refresh workspaces' })
    .click();
  await expect(page.getByText('Refreshed project')).toBeVisible();
  const workspaceDialog = page.getByRole('dialog', { name: 'Workspaces' });
  await page.keyboard.press('Escape');
  await expect(workspaceDialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Open agent list' }).click();
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  await expect(workspaceDialog).toBeVisible();
  await workspaceDialog
    .getByRole('button', { name: 'Close Workspaces' })
    .click();
  // The panel stays mounted for its visual exit but leaves the accessibility tree.
  const exitingUtility = page.locator('.surface-dialog-layer.is-exiting');
  await expect(exitingUtility.locator('> div')).toHaveAttribute(
    'aria-hidden',
    'true',
  );
  await expect(page.locator('.utility-dialog')).toHaveCount(1);
  await expect(page.locator('.utility-dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open agent list' }).click();
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Workspaces' })).toBeVisible();
  await page.locator('.surface-dialog-layer').evaluate((element) => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await expect(page.getByRole('dialog', { name: 'Workspaces' })).toHaveCount(0);
  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Browser alerts' }).click();
  await expect(
    page.getByRole('button', { name: /Browser alerts on|Alerts unavailable/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\/w1\/new$/);
  await page.getByLabel('Model').selectOption('test/text');
  await page
    .getByRole('textbox', { name: 'Message Pi', exact: true })
    .fill('Inspect the project setup');
  await page.getByRole('button', { name: 'Send first message' }).click();
  await expect(page.getByText('Starting agent…')).toBeVisible();
  await expect(page).not.toHaveURL(/\/runtimes\//u);
  expect(mocks.starts[0]).toEqual({
    workspaceId: 'w1',
    initialPrompt: 'Inspect the project setup',
    model: { provider: 'test', model: 'text', thinking: 'medium' },
  });
  await page.reload();
  await expect(page.getByText('Starting agent…')).toBeVisible();
  await expect(page).not.toHaveURL(/\/runtimes\//u);
  await page.route('**/api/sessions/s-launched', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        serverId: 'phase-six',
        cursor: 2,
        metadata: {
          id: 's-launched',
          file: '/tmp/project/launched.jsonl',
          cwd: '/tmp/project',
          title: 'Inspect the project setup',
          updatedAt: 2,
          workspaceId: 'w1',
          entryCount: 1,
        },
        entries: [],
      }),
    }),
  );
  const launchedRuntime = {
    ...((phase6Snapshot({}).runtimes as unknown[])[0] as Record<
      string,
      unknown
    >),
    runtimeId: 'r-launched',
    liveState: 'working',
    pendingInteractions: [],
    session: { id: 's-launched', entries: [] },
  };
  await mocks.emit({
    type: 'snapshot',
    snapshot: phase6Snapshot({
      runtimes: [launchedRuntime],
      pendingInteractions: [],
    }),
  });
  await expect(page).toHaveURL(/\/sessions\/s-launched$/);
  await expect(page).not.toHaveURL(/\/runtimes\//u);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/sessions/s1');
  await mocks.emit({
    type: 'snapshot',
    snapshot: phase6Snapshot({ runtimes: [], pendingInteractions: [] }),
  });
  await page.getByRole('button', { name: 'Resume session' }).click();
  await expect(page.getByText('Starting agent…')).toBeVisible();
  expect(mocks.starts[1]).toEqual({ workspaceId: 'w1', sessionId: 's1' });
  const delegateStartedAt = Date.now();
  await mocks.emit({
    type: 'snapshot',
    snapshot: phase6Snapshot({
      pendingInteractions: [],
      extensionSurfaces: [
        {
          id: 'tasks-1',
          rendererId: 'tasks.current',
          placement: 'composer',
          viewModel: {
            version: 1,
            tasks: Array.from({ length: 18 }, (_, index) => ({
              id: `T${index + 1}`,
              text:
                index === 0
                  ? 'Inspect the new drawer'
                  : `Dashboard task ${index + 1}`,
              status: index === 0 ? 'doing' : 'todo',
              dependsOn: [],
              createdAt: 1,
              updatedAt: 1,
            })),
            stats: { total: 18, active: 1, done: 0, blocked: 0, ready: 17 },
          },
        },
        {
          id: 'pause-1',
          rendererId: 'runtime.pause-status',
          placement: 'composer',
          viewModel: {
            version: 1,
            phase: 'paused',
            delegateCount: 2,
            pausedAt: delegateStartedAt + 2_000,
            label: 'Paused (with 2 delegates)',
          },
        },
        {
          id: 'delegates-1',
          rendererId: 'delegate.status',
          placement: 'composer',
          viewModel: {
            version: 1,
            statuses: Array.from({ length: 18 }, (_, index) => ({
              id: `d${index + 1}`,
              name: `Dashboard delegate ${index + 1}`,
              kind: 'background',
              state: index === 0 ? 'running' : 'queued',
              pauseState: index === 0 ? 'paused' : 'pausing',
              ...(index === 0 ? { pausedAt: delegateStartedAt + 2_000 } : {}),
              createdAt: delegateStartedAt,
              allowWrites: index === 0,
              ...(index === 0
                ? {
                    startedAt: delegateStartedAt,
                    jobId: 'dj-dashboard',
                    route: 'luna-high',
                    context: 'fresh',
                    runCount: 2,
                    runs: [
                      {
                        state: 'success',
                        startedAt: delegateStartedAt - 30_000,
                        finishedAt: delegateStartedAt - 10_000,
                      },
                      { state: 'running', startedAt: delegateStartedAt },
                    ],
                    result: { kind: 'structured', status: 'valid' },
                    lifecycle: {
                      reason: 'timeout',
                      diagnostic:
                        'The child runner timed out after the final check.',
                      diagnosticArtifact: { handle: 'artifact-dashboard' },
                      continuationUsable: true,
                      writableBranchRetained: false,
                      readOnlySnapshotRetained: true,
                    },
                    transcript: [
                      ...Array.from({ length: 14 }, (_, entryIndex) => ({
                        id: `d1:tool:${entryIndex + 1}`,
                        type: 'tool',
                        label: `Validation command ${entryIndex + 1}`,
                        name: 'bash',
                        arguments: {
                          command: `pnpm test --filter validation-${entryIndex + 1}`,
                        },
                        result: {
                          output: `Command output line ${entryIndex + 1}`,
                        },
                        status: 'completed',
                        run: 1,
                      })),
                      {
                        id: 'd1:error',
                        type: 'error',
                        label: 'Error',
                        text: 'A child command failed.',
                        status: 'error',
                        run: 1,
                      },
                    ],
                  }
                : {}),
            })),
          },
        },
      ],
    }),
  });
  await expect(page.locator('.session-status')).toContainText(
    'Paused (with 2 delegates)',
  );
  await expect(page.locator('.pause-status')).toHaveCount(0);
  const pauseEvent = page.locator('.live-pause-event');
  await expect(pauseEvent).toHaveCount(1);
  await expect(pauseEvent).toContainText('Paused (with 2 delegates)');
  await expect(
    pauseEvent.getByRole('button', { name: 'Continue paused runtime' }),
  ).toBeDisabled();
  const tasksLauncher = page.getByRole('button', {
    name: /Inspect the new drawer/,
  });
  const delegatesLauncher = page.getByRole('button', {
    name: /Dashboard delegate 1/,
  });
  await expect(tasksLauncher).toContainText('0/18');
  await expect(delegatesLauncher).toContainText('18 active · 0 finished');
  await tasksLauncher.click();
  const tasksPanel = page.getByRole('dialog', { name: 'Tasks' });
  await expect(tasksPanel).toBeVisible();
  await expect(tasksPanel).toHaveClass(/work-surface-dialog/);
  await expect(tasksPanel.locator('h2')).toHaveCount(0);
  await expect(tasksPanel.locator('.eyebrow')).toHaveText('Tasks');
  await expect(tasksPanel.locator('.surface-dialog-summary')).toContainText(
    'Inspect the new drawer',
  );
  await expect(tasksPanel.locator('.surface-stats')).toContainText('1 active');
  await expect(tasksPanel.locator('.surface-stats')).toContainText(
    '0 finished',
  );
  expect(
    await tasksPanel
      .locator('.surface-dialog-body')
      .evaluate((element) => getComputedStyle(element).padding),
  ).toBe('0px');
  await expect(tasksPanel).toContainText('0 of 18 complete');
  const taskScroll = await tasksPanel
    .locator('.surface-scroll-region')
    .evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
  expect(taskScroll.clientHeight).toBeGreaterThan(0);
  expect(taskScroll.scrollHeight).toBeGreaterThan(taskScroll.clientHeight);
  const taskRowHeights = await tasksPanel
    .locator('.task-row')
    .evaluateAll((rows) =>
      rows.map((row) => row.getBoundingClientRect().height),
    );
  expect(Math.max(...taskRowHeights)).toBeLessThan(80);
  expect(
    await tasksPanel.locator('.surface-scroll-region').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    }),
  ).toBeGreaterThan(0);
  await tasksPanel.getByRole('button', { name: 'Close Tasks' }).click();
  await expect(tasksPanel).toHaveCount(0);
  await delegatesLauncher.click();
  const delegatesPanel = page.getByRole('dialog', { name: 'Delegates' });
  await expect(delegatesPanel).toBeVisible();
  await expect(delegatesPanel.locator('h2')).toHaveCount(0);
  await expect(delegatesPanel.locator('.eyebrow')).toHaveText('Delegates');
  const delegateBody = delegatesPanel.locator('.surface-dialog-body');
  expect(
    await delegateBody.evaluate((element) => ({
      top: getComputedStyle(element).paddingTop,
      right: getComputedStyle(element).paddingRight,
      bottom: getComputedStyle(element).paddingBottom,
      left: getComputedStyle(element).paddingLeft,
    })),
  ).toEqual({ top: '0px', right: '0px', bottom: '0px', left: '0px' });
  const delegateStats = delegatesPanel.locator('.surface-stats');
  await expect(delegateStats).toContainText('18 active');
  await expect(delegateStats).toContainText('0 finished');
  expect(
    await delegateStats.evaluate((element) => {
      const [activeSection, finishedSection] = Array.from(
        element.children,
      ) as HTMLElement[];
      if (!activeSection || !finishedSection)
        throw new Error('Split delegate stats not found');
      return {
        display: getComputedStyle(element).display,
        height: element.getBoundingClientRect().height,
        topDelta: Math.abs(
          activeSection.getBoundingClientRect().top -
            finishedSection.getBoundingClientRect().top,
        ),
        divider: getComputedStyle(finishedSection).borderLeftStyle,
      };
    }),
  ).toMatchObject({ display: 'inline-flex', topDelta: 0, divider: 'solid' });
  expect(
    await delegateStats.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
  ).toBeLessThan(30);
  expect(
    await delegateStats.evaluate((element) =>
      element.parentElement?.classList.contains(
        'surface-dialog-header-content',
      ),
    ),
  ).toBe(true);
  expect(
    await delegatesPanel
      .locator('.surface-paused .surface-state')
      .first()
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe('none');
  const runningMeta = delegatesPanel.locator('.delegate-row-meta').first();
  await expect(runningMeta.locator('.delegate-row-status')).toContainText(
    'paused',
  );
  await expect(delegatesPanel.locator('.surface-pausing')).toHaveCount(17);
  await expect(delegatesPanel.locator('.surface-paused')).toHaveCount(1);
  await expect(delegatesPanel).toContainText('Paused at a safe boundary');
  await expect(delegatesPanel).toContainText('Pausing at a safe boundary');
  await expect(runningMeta.locator('.delegate-row-properties')).toContainText(
    'run 2 · read/write · luna-high',
  );
  await expect(
    runningMeta.locator('.delegate-row-mobile-elapsed'),
  ).toBeHidden();
  const runningElapsed = runningMeta.locator('.delegate-row-status');
  const initialElapsed = await runningElapsed.textContent();
  await page.waitForTimeout(1_200);
  expect(await runningElapsed.textContent()).toBe(initialElapsed);
  const delegateScroll = await delegatesPanel
    .locator('.surface-scroll-region')
    .evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
  expect(delegateScroll.clientHeight).toBeGreaterThan(0);
  expect(delegateScroll.scrollHeight).toBeGreaterThan(
    delegateScroll.clientHeight,
  );
  const delegateRowHeights = await delegatesPanel
    .locator('.delegate-row')
    .evaluateAll((rows) =>
      rows.map((row) => row.getBoundingClientRect().height),
    );
  expect(Math.max(...delegateRowHeights)).toBeLessThan(80);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(runningMeta.locator('.delegate-row-status')).toBeHidden();
  await expect(
    runningMeta.locator('.delegate-row-mobile-elapsed'),
  ).toBeVisible();
  expect(
    await runningMeta.evaluate((element) => ({
      gridColumn: getComputedStyle(element).gridColumnStart,
      textAlign: getComputedStyle(element).textAlign,
    })),
  ).toEqual({ gridColumn: '2', textAlign: 'left' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await delegatesPanel.locator('.delegate-row-toggle').first().click();
  const transcriptInspector = page.getByRole('dialog', {
    name: 'Delegate transcript',
  });
  await expect(transcriptInspector).toBeVisible();
  await expect(
    transcriptInspector.locator('.surface-dialog-summary'),
  ).toContainText('Dashboard delegate 1');
  await expect(
    transcriptInspector.locator('.delegate-inspector-metadata'),
  ).toContainText('result valid');
  await expect(
    transcriptInspector.getByRole('region', { name: 'Delegate transcript' }),
  ).toBeVisible();
  const delegateTool = transcriptInspector.locator('.tool-detail').first();
  await delegateTool.click();
  await expect(delegateTool.getByLabel('Arguments')).toContainText(
    'pnpm test --filter validation-1',
  );
  await expect(delegateTool.getByLabel('Result')).toContainText(
    'Command output line 1',
  );
  const delegateError = transcriptInspector.locator(
    '.event-delegate-result.event-failed',
  );
  await delegateError.click();
  await expect(delegateError).toContainText('A child command failed.');
  await transcriptInspector.getByText('Run and recovery details').click();
  const delegateDetails = transcriptInspector.locator(
    '.delegate-inspector-details',
  );
  await expect(delegateDetails).toContainText('dj-dashboard');
  await expect(delegateDetails).toContainText('Run 1');
  await expect(delegateDetails).toContainText(
    'The child runner timed out after the final check.',
  );
  await expect(delegateDetails).toContainText('artifact-dashboard');
  await transcriptInspector
    .getByRole('button', { name: 'Close Delegate transcript' })
    .click();
  // The controlled drawer stays mounted for its exit animation and focus return.
  const exitingDelegateInspector = page.locator('.delegate-transcript-dialog');
  await expect(exitingDelegateInspector).toHaveCount(1);
  await expect(transcriptInspector).toHaveCount(0);
  await expect(exitingDelegateInspector).toHaveCount(0);
  await expect(delegatesPanel).toBeVisible();
  await delegatesPanel.locator('.delegate-row-toggle').first().click();
  await expect(transcriptInspector).toBeVisible();
  // A delta removing the selected row must close the inspector and the open
  // delegate surface rather than leaving stale transcript details behind.
  await mocks.emit({
    type: 'snapshot',
    snapshot: phase6Snapshot({
      pendingInteractions: [],
      extensionSurfaces: [
        {
          id: 'tasks-1',
          rendererId: 'tasks.current',
          placement: 'composer',
          viewModel: {
            version: 1,
            tasks: [],
            stats: { total: 0, active: 0, done: 0, blocked: 0, ready: 0 },
          },
        },
        {
          id: 'delegates-1',
          rendererId: 'delegate.status',
          placement: 'composer',
          viewModel: { version: 1, statuses: [] },
        },
      ],
    }),
  });
  await expect(transcriptInspector).toHaveCount(0);
  await expect(page.locator('.extension-surface')).toHaveCount(0);
  const detailsButton = page.getByRole('button', {
    name: 'Details',
    exact: true,
  });
  await expect(detailsButton).toBeFocused();
  await detailsButton.click();
  const inspector = page.getByRole('dialog', {
    name: 'Existing session request',
  });
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText('Runtime controls');
  await expect(inspector).not.toContainText('Live work');
  await expect(inspector).not.toContainText('test/vision');
  await swipe(inspector, { dx: 44 });
  await expect(inspector).toBeVisible();
  await swipe(inspector, { dx: 104, dy: 8 });
  await expect(inspector).toHaveCount(0);
  await expect(detailsButton).toBeFocused();
  await detailsButton.click();
  await expect(inspector).toBeVisible();
  await page
    .locator('.surface-dialog-layer')
    .click({ position: { x: 2, y: 2 } });
  await expect(inspector).toHaveCount(0);
  await expect(detailsButton).toBeFocused();
  await detailsButton.click();
  await expect(inspector).toBeVisible();
  const readDesktopGeometry = () =>
    page.evaluate(() => {
      const rail = document
        .querySelector('.agent-thread-nav-session')
        ?.getBoundingClientRect();
      const composerElement = document.querySelector<HTMLElement>('.composer');
      const composer = composerElement?.getBoundingClientRect();
      const inspector = document
        .querySelector('.session-inspector')
        ?.getBoundingClientRect();
      return rail && composer && inspector && composerElement
        ? {
            railRight: rail.right,
            composerLeft: composer.left,
            composerRight: composer.right,
            composerVisibility: getComputedStyle(composerElement).visibility,
            inspectorLeft: inspector.left,
          }
        : undefined;
    });
  for (const width of [1200, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await readDesktopGeometry();
    expect(geometry?.composerLeft).toBeGreaterThanOrEqual(
      geometry?.railRight ?? Number.POSITIVE_INFINITY,
    );
    expect(geometry?.composerRight).toBeLessThanOrEqual(
      geometry?.inspectorLeft ?? Number.NEGATIVE_INFINITY,
    );
  }
  await page.setViewportSize({ width: 1024, height: 900 });
  expect((await readDesktopGeometry())?.composerVisibility).toBe('hidden');
  await page.setViewportSize({ width: 1440, height: 900 });
  const exitState = await page.evaluate(() => {
    document
      .querySelector<HTMLButtonElement>(
        '#session-inspector button[aria-label="Close session details"]',
      )
      ?.click();
    return new Promise<{ exiting: boolean; headingVisibility: string }>(
      (resolve) =>
        window.setTimeout(() => {
          const layer = document.querySelector('.surface-dialog-layer');
          const heading = document.querySelector(
            '.session-page > .session-heading h1',
          );
          resolve({
            exiting: layer?.classList.contains('is-exiting') ?? false,
            headingVisibility: heading
              ? getComputedStyle(heading).visibility
              : 'missing',
          });
        }, 16),
    );
  });
  expect(exitState).toEqual({ exiting: true, headingVisibility: 'visible' });
  await expect(inspector).toHaveCount(0);
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  const reopenedInspector = page.getByRole('dialog');
  await expect(
    reopenedInspector.getByRole('button', { name: 'Stop', exact: true }),
  ).toBeVisible();
  const pauseButton = reopenedInspector.getByRole('button', {
    name: 'Pause',
    exact: true,
  });
  await expect(pauseButton).toBeVisible();
  await pauseButton.click();
  await expect
    .poll(() =>
      mocks.commands.some(
        (command) =>
          command.type === 'action.invoke' &&
          command.actionId === 'runtime.pause',
      ),
    )
    .toBe(true);
  const stopButton = reopenedInspector.getByRole('button', {
    name: 'Stop',
    exact: true,
  });
  const forceStopButton = reopenedInspector.getByRole('button', {
    name: 'Force stop',
    exact: true,
  });
  const restartButton = reopenedInspector.getByRole('button', {
    name: 'Restart',
    exact: true,
  });
  await stopButton.click();
  await expect(forceStopButton).toBeEnabled();
  await forceStopButton.click();
  await expect.poll(() => mocks.stops.length).toBe(2);
  await expect(restartButton).toBeEnabled();
  await restartButton.click();
  await expect(page).toHaveURL(/\/runtimes\/r-restarted$/);
  expect(mocks.stops).toEqual([{ force: false }, { force: true }]);
  expect(mocks.restarts[0]?.id).toBeTruthy();
});
