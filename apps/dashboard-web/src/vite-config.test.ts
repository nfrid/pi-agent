import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { createDashboardTrpcClient } from '../../../packages/dashboard-client/src/trpc-client.js';
import Fastify from '../../dashboard-server/node_modules/fastify/fastify.js';
import {
  NATIVE_ENDPOINT,
  NATIVE_ORIGIN,
} from '../../dashboard-server/src/native-notifications.js';
import { dashboardRoutes } from '../../dashboard-server/src/routes.js';
import config, {
  dashboardApiTarget,
  rewriteDashboardProxyOrigin,
  stampDashboardServiceWorker,
} from '../vite.config';

describe('dashboard Vite proxy configuration', () => {
  it('proxies tRPC through both dev and preview servers', () => {
    const serverProxy = config.server?.proxy;
    const previewProxy = config.preview?.proxy;

    expect(serverProxy).toMatchObject({
      '/api': { target: dashboardApiTarget },
      '/trpc': { target: dashboardApiTarget },
    });
    expect(previewProxy).toMatchObject({
      '/api': { target: dashboardApiTarget },
      '/trpc': { target: dashboardApiTarget },
    });
    const serverTrpc = serverProxy?.['/trpc'];
    const previewTrpc = previewProxy?.['/trpc'];
    expect(
      typeof (serverTrpc && typeof serverTrpc !== 'string'
        ? serverTrpc.configure
        : undefined),
    ).toBe('function');
    expect(
      typeof (previewTrpc && typeof previewTrpc !== 'string'
        ? previewTrpc.configure
        : undefined),
    ).toBe('function');
  });

  it('rewrites loopback browser origins so proxied mutations pass the API allow-list', () => {
    const rewritten: Record<string, string> = {};
    rewriteDashboardProxyOrigin(
      {
        setHeader(name, value) {
          rewritten[name] = value;
        },
      },
      { headers: { origin: 'http://127.0.0.1:4176' } },
    );
    expect(rewritten.origin).toBe(dashboardApiTarget);

    const localhost: Record<string, string> = {};
    rewriteDashboardProxyOrigin(
      {
        setHeader(name, value) {
          localhost[name] = value;
        },
      },
      { headers: { origin: 'http://localhost:4176' } },
    );
    expect(localhost.origin).toBe(dashboardApiTarget);

    const remote: Record<string, string> = {};
    rewriteDashboardProxyOrigin(
      {
        setHeader(name, value) {
          remote[name] = value;
        },
      },
      { headers: { origin: 'https://evil.example' } },
    );
    expect(remote.origin).toBeUndefined();
  });

  it('preserves only the exact installed-PWA Origin on native proxy procedures', () => {
    for (const url of [
      '/trpc/nativeControl',
      '/trpc/nativeClicks?input=%7B%7D',
      '/trpc/protocolInfo%2CnativeControl?batch=1',
      '/api/push/foreground',
    ]) {
      const headers: Record<string, string> = {};
      rewriteDashboardProxyOrigin(
        {
          setHeader: (name, value) => {
            headers[name] = value;
          },
        },
        { headers: { origin: 'http://127.0.0.1:4174' }, url },
        'http://127.0.0.1:4173',
      );
      expect(headers.origin).toBeUndefined();
    }
    for (const [origin, url] of [
      ['http://127.0.0.1:4174', '/trpc/protocolInfo'],
      ['http://127.0.0.1:4175', '/trpc/nativeControl'],
      ['http://127.0.0.1:4175', '/trpc/nativeControl'],
    ]) {
      const headers: Record<string, string> = {};
      rewriteDashboardProxyOrigin(
        {
          setHeader: (name, value) => {
            headers[name] = value;
          },
        },
        { headers: { origin }, url },
        'http://127.0.0.1:4173',
      );
      expect(headers.origin).toBe('http://127.0.0.1:4173');
    }
    const remote: Record<string, string> = {};
    rewriteDashboardProxyOrigin(
      {
        setHeader: (name, value) => {
          remote[name] = value;
        },
      },
      {
        headers: { origin: 'https://evil.example' },
        url: '/trpc/nativeControl',
      },
      'http://127.0.0.1:4173',
    );
    expect(remote.origin).toBeUndefined();
  });

  it('forwards native browser requests through a real isolated Vite proxy without rewriting their Origin', async () => {
    const received: Array<{ url?: string; origin?: string }> = [];
    const api = createHttpServer((request, response) => {
      received.push({ url: request.url, origin: request.headers.origin });
      request.resume();
      if (request.url?.startsWith('/trpc/nativeClicks')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('event: connected\\ndata: {}\\n\\n');
      } else response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const apiAddress = api.address();
    if (!apiAddress || typeof apiAddress === 'string')
      throw new Error('Isolated API did not bind.');
    const target = `http://127.0.0.1:${apiAddress.port}`;
    const proxy = await createViteServer({
      configFile: false,
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port: 0,
        proxy: Object.fromEntries(
          ['/trpc', '/api'].map((prefix) => [
            prefix,
            {
              target,
              configure(server) {
                server.on('proxyReq', (proxyRequest, request) =>
                  rewriteDashboardProxyOrigin(proxyRequest, request, target),
                );
              },
            },
          ]),
        ),
      },
    });
    try {
      await proxy.listen();
      const address = proxy.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Isolated Vite proxy did not bind.');
      const base = `http://127.0.0.1:${address.port}`;
      for (const url of [
        '/trpc/nativeControl',
        '/trpc/nativeClicks?input=%7B%7D',
        '/api/push/foreground',
      ]) {
        const response = await fetch(`${base}${url}`, {
          method: url.includes('nativeClicks') ? 'GET' : 'POST',
          headers: {
            origin: 'http://127.0.0.1:4174',
            'content-type': 'application/json',
          },
          body: url.includes('nativeClicks') ? undefined : '{}',
        });
        expect(response.status).toBe(url.includes('nativeClicks') ? 200 : 204);
      }
      await fetch(`${base}/trpc/protocolInfo`, {
        headers: { origin: 'http://127.0.0.1:4174' },
      });
      expect(received.map((value) => value.origin)).toEqual([
        'http://127.0.0.1:4174',
        'http://127.0.0.1:4174',
        'http://127.0.0.1:4174',
        target,
      ]);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) =>
        api.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('routes real native tRPC and foreground requests through Vite to the isolated dashboard API', async () => {
    const api = Fastify();
    const removed: string[] = [];
    const reports: Array<Record<string, unknown>> = [];
    const actions: string[] = [];
    let enabled = false;
    let clickRead = false;
    const native = {
      async control(action: string, _url?: string, beforeEnable?: () => void) {
        actions.push(action);
        if (action === 'enable') {
          beforeEnable?.();
          enabled = true;
        }
        if (action === 'disable') enabled = false;
        return {
          available: true,
          enabled,
          permission: enabled ? 'authorized' : 'notDetermined',
        };
      },
      isEnabled: () => enabled,
      click: () => {
        clickRead = true;
        return { id: 'click-proxy-test', path: '/sessions/thread%2Fone' };
      },
      acknowledge() {},
    };
    const context = {
      token: 'proxy-test-token',
      serverId: () => 'proxy-test',
      origins: () => [NATIVE_ORIGIN],
      nativeNotifications: () => native,
      removePushSubscription: (endpoint: string) => {
        removed.push(endpoint);
      },
      snapshot: () => ({
        serverId: 'proxy-test',
        revision: 1,
        cursor: 1,
        runtimes: [],
        sessions: [],
        unread: [],
      }),
      usage: async () => ({ usage: null }),
      readDelegateHistory: async () => ({}),
      readDelegateHistoryRun: async () => ({}),
      renameSession: async () => ({}),
      startRuntime: async () => ({}),
      commandRuntime: async () => ({}),
      stopRuntime: async () => {},
      markNotificationRead() {},
      markAllNotificationsRead() {},
      pushSubscribe() {},
      vapidPublicKey: () => null,
      reportPushForeground: (report: Record<string, unknown>) =>
        reports.push(report),
    };
    await api.register(dashboardRoutes, { context: context as never });
    const apiAddress = await api.listen({ port: 0, host: '127.0.0.1' });
    const proxy = await createViteServer({
      configFile: false,
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port: 0,
        proxy: Object.fromEntries(
          ['/trpc', '/api'].map((prefix) => [
            prefix,
            {
              target: apiAddress,
              configure(server) {
                server.on('proxyReq', (proxyRequest, request) =>
                  rewriteDashboardProxyOrigin(
                    proxyRequest,
                    request,
                    apiAddress,
                  ),
                );
              },
            },
          ]),
        ),
      },
    });
    let subscription: { unsubscribe(): void } | undefined;
    try {
      await proxy.listen();
      const proxyAddress = proxy.httpServer?.address();
      if (!proxyAddress || typeof proxyAddress === 'string')
        throw new Error('API proxy did not bind.');
      const client = createDashboardTrpcClient({
        baseUrl: `http://127.0.0.1:${proxyAddress.port}`,
        tokenStore: { get: () => 'proxy-test-token', set() {}, clear() {} },
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          if (init?.method === 'POST') headers.set('origin', NATIVE_ORIGIN);
          else headers.set('referer', `${NATIVE_ORIGIN}/`);
          return fetch(input, { ...init, headers });
        },
      });
      expect(
        (await client.nativeControl.mutate({ action: 'status' })).enabled,
      ).toBe(false);
      expect(
        (
          await client.nativeControl.mutate({
            action: 'enable',
            endpoint: 'current-mac',
          })
        ).enabled,
      ).toBe(true);
      expect(removed).toEqual(['current-mac']);
      const click = new Promise<{ id: string; path: string }>(
        (resolve, reject) => {
          subscription = client.nativeClicks.subscribe(undefined, {
            onData: resolve,
            onError: reject,
          });
        },
      );
      await expect(click).resolves.toEqual({
        id: 'click-proxy-test',
        path: '/sessions/thread%2Fone',
      });
      subscription?.unsubscribe();
      const foreground = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/api/push/foreground`,
        {
          method: 'POST',
          headers: {
            origin: NATIVE_ORIGIN,
            'x-dashboard-token': 'proxy-test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            endpoint: NATIVE_ENDPOINT,
            tabId: 'pwa',
            visible: true,
            focused: true,
            sessionId: 'thread/one',
          }),
        },
      );
      expect(foreground.status).toBe(204);
      expect(reports).toEqual([
        expect.objectContaining({
          endpoint: NATIVE_ENDPOINT,
          sessionId: 'thread/one',
        }),
      ]);
      expect(clickRead).toBe(true);
    } finally {
      subscription?.unsubscribe();
      await proxy.close();
      await api.close();
    }
  });

  it('lets preview serve the build-time version assets unchanged', () => {
    const plugins = ((config as { plugins?: unknown[] }).plugins ?? []).flat(
      Infinity,
    ) as Array<{
      name?: string;
      configurePreviewServer?: unknown;
    }>;
    const versionPlugin = plugins.find(
      (plugin) => plugin?.name === 'dashboard-version',
    );

    expect(versionPlugin).toBeDefined();
    expect(versionPlugin?.configurePreviewServer).toBeUndefined();
  });

  it('stamps each emitted worker with its build ID', () => {
    const source = readFileSync(
      new URL('../public/sw.js', import.meta.url),
      'utf8',
    );
    const first = stampDashboardServiceWorker(source, 'release-1');
    const second = stampDashboardServiceWorker(source, 'release-2');

    expect(first).toContain('const DASHBOARD_BUILD_ID = "release-1";');
    expect(second).toContain('const DASHBOARD_BUILD_ID = "release-2";');
    expect(first).not.toBe(second);
    expect(first).not.toContain('__PI_DASHBOARD_BUILD_ID__');
  });
});
