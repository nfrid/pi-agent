import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
