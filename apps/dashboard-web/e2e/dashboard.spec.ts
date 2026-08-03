import { expect, test } from '@playwright/test';

test('mobile dashboard renders and supports the new-agent route', async ({
  page,
}) => {
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
    page.getByRole('button', { name: 'ghost-session offline' }),
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

test('dense mobile session keeps conversation and activity readable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.addInitScript(() => {
    class FakeDashboardSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        (
          window as unknown as { dashboardTestSocket: FakeDashboardSocket }
        ).dashboardTestSocket = this;
        window.setTimeout(() => this.onopen?.(), 0);
      }
      send() {}
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
      emit(value: unknown) {
        this.onmessage?.({ data: JSON.stringify(value) });
      }
    }
    Object.defineProperty(window, 'WebSocket', { value: FakeDashboardSocket });
  });
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
  await page.route(/\/api\/sessions\/[^/]+$/, async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        metadata: { id: 's1', file: '', cwd: '/tmp', updatedAt: Date.now() },
        entries: [
          ...Array.from({ length: 30 }, (_, index) => ({
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
              content: [{ type: 'text', text: 'Check the dashboard.' }],
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
        ],
      }),
    }),
  );
  await page.goto('/sessions/s1');
  await expect(page.getByText('Check the dashboard.')).toBeVisible();
  const activity = page.getByRole('button', {
    name: /Checking the mobile transcript.*1 tool/,
  });
  await expect(activity).toBeVisible();
  await expect(page.getByLabel('Message Pi')).toBeVisible();
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
  const emitMessage = async (type: string, timestamp: number, text: string) =>
    page.evaluate(
      ({ type, timestamp, text }) => {
        (
          window as unknown as {
            dashboardTestSocket: { emit(value: unknown): void };
          }
        ).dashboardTestSocket.emit({
          type: 'bridge.event',
          event: {
            type,
            sessionId: 's1',
            message: {
              message: {
                role: 'user',
                timestamp,
                content: [{ type: 'text', text }],
              },
            },
          },
        });
      },
      { type, timestamp, text },
    );
  await emitMessage('message.started', 123, 'Live dashboard message');
  await expect(page.getByText('Live dashboard message')).toHaveCount(1);
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
