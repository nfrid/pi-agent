import { expect, type Page, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

const snapshot = {
  serverId: 'delegate-history-e2e',
  revision: 1,
  cursor: 1,
  runtimes: [],
  workspaces: [],
  sessions: [
    {
      id: 'historical-session',
      file: '/tmp/historical-session.jsonl',
      cwd: '/tmp',
      updatedAt: 1,
    },
  ],
  unread: [],
};

const metadata = snapshot.sessions[0];

const historicalRun = {
  runId: 'run-e2e',
  lineageId: 'lineage-e2e',
  name: 'Offline historical worker',
  kind: 'background',
  state: 'success',
  createdAt: 1,
  finishedAt: 2,
  route: 'luna-high',
  isolation: 'worktree',
  allowWrites: false,
  usage: {
    input: 10_000,
    output: 2_000,
    cacheRead: 4_000,
    cacheWrite: 0,
    contextTokens: 136_000,
    cost: 0.12,
    turns: 3,
  },
};

const history = {
  version: 2,
  sessionId: 'historical-session',
  groups: [
    {
      id: 'lineage-e2e',
      ...historicalRun,
      usage: undefined,
      runCount: 1,
      runs: [historicalRun],
    },
  ],
};

const historyDetail = {
  version: 1,
  sessionId: 'historical-session',
  lineageId: 'lineage-e2e',
  runId: 'run-e2e',
  run: {
    ...historicalRun,
    details: {
      task: 'Inspect the historical fixture',
      setup: {
        cwd: '/tmp',
        isolation: 'worktree',
        worktree: { branch: 'pi/history-review' },
      },
      runConfig: {
        scope: ['apps/dashboard-web'],
        parentContextNote: 'Keep the review concise.',
        inputs: [
          {
            identity: 'source@1',
            kind: 'report',
            label: 'Source report',
            content: 'The source delegate completed its scan.',
          },
        ],
      },
      renderedPrompt:
        'You are a coding subagent.\n\nInspect the historical fixture.',
      activities: [
        {
          type: 'tool',
          label: 'read fixture',
          name: 'read',
          arguments: { path: 'fixture.txt' },
          result: { content: 'historical result' },
          status: 'completed',
        },
      ],
      warnings: ['This transcript is historical.'],
      truncated: true,
    },
  },
};

async function inspectPersistedDelegate(
  page: Page,
  { canonicalTranscript = false, compactContext = false } = {},
) {
  const selectedRun = canonicalTranscript
    ? { ...historicalRun, sessionId: 'historical-session' }
    : historicalRun;
  const selectedHistory = {
    ...history,
    groups: [
      {
        ...history.groups[0],
        ...selectedRun,
        usage: undefined,
        runs: [selectedRun],
      },
    ],
  };
  const selectedHistoryDetail = {
    ...historyDetail,
    run: { ...historyDetail.run, ...selectedRun },
  };
  const initialSessionSnapshot = {
    metadata,
    entries: [
      { type: 'session', id: 'historical-session', cwd: '/tmp' },
      ...Array.from({ length: canonicalTranscript ? 80 : 1 }, (_, index) => ({
        type: 'message',
        id: `historical-message-${index}`,
        message: {
          role: 'user',
          content:
            index === 0
              ? 'Show persisted delegate work'
              : `Historical transcript entry ${index}`,
        },
      })),
    ],
    entriesComplete: true,
    serverId: 'delegate-history-e2e',
    cursor: 0,
    active: {
      messages: [],
      tools: [],
      delegates: [],
      truncated: false,
    },
    completeThroughCursor: true,
  };
  await page.addInitScript((initial) => {
    localStorage.setItem('pi-dashboard-token', 'test-token');
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let sequence = 0;
    const originalFetch = window.fetch.bind(window);
    const frame = (id: string, data: unknown) =>
      `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
    const testWindow = window as typeof window & {
      emitDashboardEvent(value: { event?: unknown }): void;
    };
    testWindow.emitDashboardEvent = (value) => {
      const next = ++sequence;
      controller?.enqueue(
        new TextEncoder().encode(
          frame(`session-${next}`, {
            type: 'session-event',
            sequence: next,
            sessionId: 'historical-session',
            event: value.event,
          }),
        ),
      );
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
      return new Response(
        new ReadableStream<Uint8Array>({
          start(nextController) {
            controller = nextController;
            controller.enqueue(
              new TextEncoder().encode(
                'event: connected\ndata: {"reconnectAfterInactivityMs":60000}\n\n',
              ),
            );
            controller.enqueue(
              new TextEncoder().encode(
                frame('session-snapshot', {
                  type: 'snapshot',
                  sequence: 0,
                  snapshot: initial,
                }),
              ),
            );
            controller.enqueue(
              new TextEncoder().encode(
                frame('session-caught-up', { type: 'caught-up', sequence: 0 }),
              ),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    };
  }, initialSessionSnapshot);
  await installDashboardBootstrap(page, snapshot);
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  let historyLeafId = 'leaf-1';
  let historyRequests = 0;
  await page.route(
    '**/api/sessions/historical-session/delegate-history/runs/run-e2e?*',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(selectedHistoryDetail),
      }),
  );
  await page.route(
    '**/api/sessions/historical-session/delegate-history',
    (route) => {
      historyRequests += 1;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ...selectedHistory, leafId: historyLeafId }),
      });
    },
  );

  await page.goto('/sessions/historical-session');
  const delegateLauncher = page.getByRole('button', {
    name: /Delegates.*0 running, 0 queued, 0 need attention, 1 done.*All delegates complete/,
  });
  await expect(delegateLauncher).toBeVisible();
  await delegateLauncher.click();
  await page.getByRole('button', { name: /Offline historical worker/ }).click();
  const inspector = page.getByRole('dialog', {
    name: 'Delegate · Offline historical worker',
  });
  await expect(
    inspector.getByText('Inspect the historical fixture', { exact: true }),
  ).toBeVisible();
  await expect(inspector.getByText('scope apps/dashboard-web')).toBeVisible();
  const stickySetup = inspector.locator('.delegate-inspector-sticky-setup');
  await expect(stickySetup.getByText('luna-high')).toBeVisible();
  await expect(stickySetup.getByText('pi/history-review')).toBeVisible();
  await expect(stickySetup.getByText('50%')).toBeVisible();
  if (compactContext)
    await expect(stickySetup.getByText('136k / 272k')).toBeHidden();
  else await expect(stickySetup.getByText('136k / 272k')).toBeVisible();
  await stickySetup.getByLabel('Final context window 50%').click();
  const contextPopover = stickySetup.locator('.delegate-context-popover');
  await expect(contextPopover.getByText('136k')).toBeVisible();
  await expect(contextPopover.getByText('$0.1200')).toBeVisible();
  await stickySetup.getByLabel('Final context window 50%').click();
  await expect(inspector.getByText('Keep the review concise.')).toBeHidden();
  await inspector.getByText('Details', { exact: true }).click();
  await expect(inspector.getByText('Keep the review concise.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Delegates' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Offline historical worker/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Offline historical worker/ }).click();
  await page.getByText('Details', { exact: true }).click();
  await page.getByText('Source report').click();
  await expect(
    page.getByText('The source delegate completed its scan.'),
  ).toBeVisible();
  const renderedPrompt = page.getByText('You are a coding subagent.');
  await expect(renderedPrompt).toBeHidden();
  await page.getByText('Exact prompt').click();
  await expect(renderedPrompt).toBeVisible();
  if (canonicalTranscript) {
    const drawer = page.getByRole('dialog', {
      name: 'Delegate · Offline historical worker',
    });
    const body = page.locator('.delegate-transcript-inspector-body');
    const requestMarker = drawer
      .locator('.transcript-minimap-marker.outline-delegate-request')
      .first();
    await expect(requestMarker).toHaveAttribute(
      'aria-label',
      'Inspect the historical fixture',
    );
    await expect(
      requestMarker.locator('.transcript-minimap-preview'),
    ).toHaveAttribute('data-meta', /Parent request/);
    const layout = await drawer.evaluate((element) => {
      const body = element.querySelector<HTMLElement>(
        '.delegate-transcript-inspector-body',
      );
      const transcript = element.querySelector<HTMLElement>(
        '.delegate-canonical-session-transcript',
      );
      if (!body || !transcript) throw new Error('delegate transcript missing');
      return {
        drawerWidth: element.getBoundingClientRect().width,
        transcriptWidth: transcript.getBoundingClientRect().width,
        bodyPaddingRight: Number.parseFloat(
          getComputedStyle(body).paddingRight,
        ),
      };
    });
    expect(layout).toEqual({
      drawerWidth: 917,
      transcriptWidth: 856,
      bodyPaddingRight: 42,
    });
    await expect(body.getByText('Show persisted delegate work')).toHaveCount(0);
    await expect
      .poll(() =>
        body.evaluate((element) => element.scrollHeight - element.clientHeight),
      )
      .toBeGreaterThan(300);
    await body.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
      element.scrollTop = Math.max(
        0,
        element.scrollHeight - element.clientHeight - 240,
      );
      element.dispatchEvent(new Event('scroll'));
    });
    const stickyGeometry = await stickySetup.evaluate((element) => {
      const body = element.parentElement;
      if (!body) throw new Error('delegate transcript body missing');
      return {
        stickyTop: Math.round(element.getBoundingClientRect().top),
        bodyTop: Math.round(body.getBoundingClientRect().top),
      };
    });
    expect(stickyGeometry.stickyTop - stickyGeometry.bodyTop).toBe(14);
    const jump = page.getByRole('button', {
      name: 'Jump to latest delegate transcript activity',
    });
    await expect(jump).toBeVisible();
    const firstTop = await jump.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    await body.evaluate((element) => {
      element.scrollTop = Math.max(0, element.scrollTop - 100);
      element.dispatchEvent(new Event('scroll'));
    });
    await expect
      .poll(() =>
        jump.evaluate((element) => element.getBoundingClientRect().top),
      )
      .toBeCloseTo(firstTop, 0);
    const geometry = await jump.evaluate((element) => {
      const body = element.closest('.delegate-transcript-inspector-body');
      if (!body) throw new Error('delegate transcript body missing');
      const buttonRect = element.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      return {
        buttonBottom: buttonRect.bottom,
        bodyTop: bodyRect.top,
        bodyBottom: bodyRect.bottom,
      };
    });
    expect(geometry.buttonBottom).toBeLessThan(geometry.bodyBottom);
    expect(geometry.buttonBottom).toBeGreaterThan(geometry.bodyTop);
    await jump.click();
    await expect(jump).toHaveCount(0);
    return;
  }
  await expect(
    page.getByText(
      'Limited transcript — this older delegate has no child session.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText('Earlier historical transcript entries were omitted'),
  ).toBeVisible();

  historyLeafId = 'leaf-2';
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      emitDashboardEvent(value: unknown): void;
    };
    testWindow.emitDashboardEvent({
      cursor: 2,
      emittedAt: Date.now(),
      event: {
        type: 'session.changed',
        session: {
          id: 'historical-session',
          file: '/tmp/historical-session.jsonl',
          cwd: '/tmp',
          leafId: 'leaf-2',
          entries: [],
          entriesComplete: true,
        },
      },
    });
  });
  await expect.poll(() => historyRequests).toBeGreaterThan(1);
  await expect(
    page.getByRole('dialog', {
      name: 'Delegate · Offline historical worker',
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('dialog', {
        name: 'Delegate · Offline historical worker',
      })
      .getByText('Inspect the historical fixture', { exact: true }),
  ).toBeVisible();
}

test('shows and inspects a persisted delegate in an offline session', async ({
  page,
}) => inspectPersistedDelegate(page, { compactContext: true }));

test('shows and inspects a persisted delegate in an offline session @desktop', async ({
  page,
}) => inspectPersistedDelegate(page));

test('keeps delegate jump-to-latest fixed to the transcript viewport @desktop', async ({
  page,
}) => inspectPersistedDelegate(page, { canonicalTranscript: true }));
