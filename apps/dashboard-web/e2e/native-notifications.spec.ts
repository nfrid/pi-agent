import { createServer, type ServerResponse } from 'node:http';
import { expect, test } from '@playwright/test';
import { nativeOriginAllowed } from '../../dashboard-server/src/trpc.js';
import {
  dashboardTrpcInput,
  installDashboardBootstrap,
  trpcData,
} from './dashboard-fixtures';

// The page uses the production PWA origin but every request is intercepted and
// fetched from the isolated test preview. No request reaches the live dashboard.
const origin = 'http://127.0.0.1:4174';
test('Chromium nativeClicks GET uses same-origin Referer without Origin through isolated Vite/API @desktop', async ({
  page,
  baseURL,
}) => {
  const apiPort = Number(process.env.PI_DASHBOARD_E2E_API_PORT ?? 43_173);
  const requests: Array<{
    url?: string;
    origin?: string;
    referer?: string;
    authorized?: boolean;
  }> = [];
  const openStreams = new Set<ServerResponse>();
  const api = createServer((request, response) => {
    const authorized = nativeOriginAllowed(
      request.headers.origin,
      request.headers.referer,
    );
    requests.push({
      url: request.url,
      origin: request.headers.origin,
      referer: request.headers.referer,
      authorized,
    });
    if (request.url?.startsWith('/trpc/nativeClicks')) {
      request.resume();
      if (!authorized) {
        response.writeHead(403).end();
        return;
      }
      openStreams.add(response);
      response.on('close', () => openStreams.delete(response));
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.write(
        'event: connected\ndata: {"reconnectAfterInactivityMs":60000}\n\n',
      );
      return;
    }
    const send = (data: unknown) =>
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ result: { data } }));
    if (request.url?.startsWith('/trpc/protocolInfo')) {
      request.resume();
      send({
        protocolVersion: 3,
        serverId: 'isolated-chromium',
        capabilities: { shellSnapshot: true, sessionSnapshot: true },
      });
      return;
    }
    request.resume();
    if (request.url?.startsWith('/trpc/nativeControl')) send({});
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) =>
    api.listen(apiPort, '127.0.0.1', (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  try {
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        await route.abort();
        return;
      }
      await route.fulfill({
        response: await route.fetch({
          url: `${baseURL}${url.pathname}${url.search}`,
        }),
      });
    });
    await page.addInitScript(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query) =>
        query === '(display-mode: window-controls-overlay)'
          ? { ...original(query), matches: true }
          : original(query);
    });
    await installDashboardBootstrap(page, {
      serverId: 'isolated-chromium',
      revision: 1,
      cursor: 1,
      runtimes: [],
      sessions: [
        {
          id: 'thread/one',
          file: '/isolated/one.jsonl',
          cwd: '/isolated',
          updatedAt: 1,
        },
        {
          id: 'other',
          file: '/isolated/other.jsonl',
          cwd: '/isolated',
          updatedAt: 1,
        },
      ],
      unread: [],
    });
    await page.goto(`${origin}/sessions/other`);
    await expect
      .poll(() =>
        requests.some((request) =>
          request.url?.startsWith('/trpc/nativeClicks'),
        ),
      )
      .toBe(true);
    const nativeClicks = requests.find((request) =>
      request.url?.startsWith('/trpc/nativeClicks'),
    );
    expect(nativeClicks?.origin).toBeUndefined();
    expect(nativeClicks?.referer).toMatch(/^http:\/\/127\.0\.0\.1:4174\//);
    expect(nativeClicks?.authorized).toBe(true);
  } finally {
    for (const response of openStreams) response.end();
    await new Promise<void>((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
test('native click navigates the installed app internally and reports foreground after Web unsubscribe @desktop', async ({
  page,
  baseURL,
}) => {
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      await route.abort();
      return;
    }
    const response = await route.fetch({
      url: `${baseURL}${url.pathname}${url.search}`,
    });
    await route.fulfill({ response });
  });
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query) =>
      query === '(display-mode: window-controls-overlay)'
        ? { ...original(query), matches: true }
        : original(query);
    let unsubscribed = false;
    let holdUnsubscribe = false;
    let unsubscribeStarted = false;
    let finishUnsubscribe: ((failure?: Error) => void) | undefined;
    Object.defineProperties(window, {
      __nativeUnsubscribeStarted: { get: () => unsubscribeStarted },
      __holdNativeUnsubscribe: {
        value: () => {
          holdUnsubscribe = true;
        },
      },
      __finishNativeUnsubscribe: {
        value: (failure: boolean) =>
          finishUnsubscribe?.(
            failure ? new Error('unsubscribe failed') : undefined,
          ),
      },
    });
    Object.defineProperty(window, '__nativeUnsubscribed', {
      get: () => unsubscribed,
    });
    Object.defineProperty(navigator.serviceWorker, 'ready', {
      value: Promise.resolve({
        pushManager: {
          getSubscription: async () =>
            unsubscribed
              ? null
              : {
                  endpoint: 'current-mac',
                  toJSON: () => ({ endpoint: 'current-mac' }),
                  unsubscribe: async () => {
                    if (holdUnsubscribe) {
                      unsubscribeStarted = true;
                      await new Promise<void>((resolve, reject) => {
                        finishUnsubscribe = (error) =>
                          error ? reject(error) : resolve();
                      });
                    }
                    unsubscribed = true;
                    return true;
                  },
                },
        },
      }),
    });
    Object.defineProperty(document, 'hasFocus', { value: () => true });
  });
  await installDashboardBootstrap(
    page,
    {
      serverId: 'native-isolated-browser',
      revision: 1,
      cursor: 1,
      runtimes: [],
      sessions: [
        {
          id: 'thread/one',
          file: '/isolated/one.jsonl',
          cwd: '/isolated',
          updatedAt: 1,
        },
        {
          id: 'other',
          file: '/isolated/other.jsonl',
          cwd: '/isolated',
          updatedAt: 1,
        },
      ],
      unread: [],
    },
    { strictApi: true },
  );
  const controls: Record<string, unknown>[] = [];
  const reports: Record<string, unknown>[] = [];
  let enabled = false;
  const removedSubscriptions: string[] = [];
  let attempts = 0;
  let cancelAuthorization: (() => void) | undefined;
  const restoredSubscriptions: unknown[] = [];
  await page.route('**/api/push/subscribe', async (route) => {
    restoredSubscriptions.push(route.request().postDataJSON());
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: '{}',
    });
  });
  await page.route('**/api/settings', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ modelDisplayPreferences: {} }),
    }),
  );
  await page.route('**/trpc/nativeControl', async (route) => {
    const input = dashboardTrpcInput(route.request());
    controls.push(input);
    if (input.action === 'enable') {
      attempts += 1;
      if (attempts === 1) {
        enabled = true;
        await new Promise<void>((resolve) => {
          cancelAuthorization = resolve;
        });
      } else {
        enabled = true;
        if (typeof input.endpoint === 'string')
          removedSubscriptions.push(input.endpoint);
      }
    }
    if (input.action === 'disable') {
      enabled = false;
      cancelAuthorization?.();
    }
    await route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        available: true,
        enabled,
        permission: enabled ? 'authorized' : 'notDetermined',
      }),
    });
  });
  let deliver: (() => void) | undefined;
  await page.route('**/trpc/nativeClicks*', async (route) => {
    await new Promise<void>((resolve) => {
      deliver = resolve;
    });
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `event: connected\ndata: {}\n\ndata: ${JSON.stringify({ id: 'click-one', path: '/sessions/thread%2Fone' })}\n\n`,
    });
  });
  await page.route('**/api/push/foreground', async (route) => {
    reports.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.goto(`${origin}/sessions/other`);
  await expect.poll(() => typeof deliver).toBe('function');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Enable Mac notifications' }).click();
  await expect(
    page.getByRole('button', { name: 'Waiting for Mac permission…' }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Cancel notification request' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Enable Mac notifications' }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __nativeUnsubscribed?: boolean })
          .__nativeUnsubscribed,
    ),
  ).toBe(false);
  expect(restoredSubscriptions).toEqual([{ endpoint: 'current-mac' }]);
  await page.evaluate(() =>
    (
      window as Window & { __holdNativeUnsubscribe: () => void }
    ).__holdNativeUnsubscribe(),
  );
  const controlCountBeforeCommittedEnable = controls.length;
  await page.getByRole('button', { name: 'Enable Mac notifications' }).click();
  await expect(
    page.getByRole('button', { name: 'Finishing Mac notification setup…' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Cancel notification request' }),
  ).toHaveCount(0);
  expect(removedSubscriptions).toEqual(['current-mac']);
  expect(
    controls
      .slice(controlCountBeforeCommittedEnable)
      .some((input) => input.action === 'disable'),
  ).toBe(false);
  expect(restoredSubscriptions).toEqual([{ endpoint: 'current-mac' }]);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __nativeUnsubscribeStarted?: boolean })
            .__nativeUnsubscribeStarted,
      ),
    )
    .toBe(true);
  await page.evaluate(() =>
    (
      window as Window & {
        __finishNativeUnsubscribe: (failure: boolean) => void;
      }
    ).__finishNativeUnsubscribe(false),
  );
  await expect(
    page.getByRole('button', { name: 'Mac notifications enabled' }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __nativeUnsubscribed?: boolean })
          .__nativeUnsubscribed,
    ),
  ).toBe(true);
  expect(controls.find((input) => input.action === 'enable')).toEqual({
    action: 'enable',
    endpoint: 'current-mac',
  });
  await page.getByRole('button', { name: 'Close Settings' }).click();
  await page.evaluate(() => {
    (
      window as Window & { nativeNavigationMarker?: string }
    ).nativeNavigationMarker = 'same-document';
  });
  deliver?.();
  await expect(page).toHaveURL(`${origin}/sessions/thread%2Fone`);
  expect(
    await page.evaluate(
      () =>
        (window as Window & { nativeNavigationMarker?: string })
          .nativeNavigationMarker,
    ),
  ).toBe('same-document');
  await expect
    .poll(() =>
      controls.some(
        (input) => input.action === 'ack' && input.id === 'click-one',
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      reports.some(
        (report) =>
          report.endpoint === 'native:installed-pwa' &&
          report.sessionId === 'thread/one' &&
          report.focused === true,
      ),
    )
    .toBe(true);
});
