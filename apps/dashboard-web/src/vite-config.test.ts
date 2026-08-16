import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config, { stampDashboardServiceWorker } from '../vite.config';

describe('dashboard Vite proxy configuration', () => {
  it('proxies tRPC through both dev and preview servers', () => {
    const expectedTarget = `http://127.0.0.1:${process.env.PI_DASHBOARD_PORT ?? 4173}`;
    const serverProxy = config.server?.proxy;
    const previewProxy = config.preview?.proxy;

    expect(serverProxy).toMatchObject({
      '/trpc': { target: expectedTarget },
    });
    expect(previewProxy).toMatchObject({
      '/trpc': { target: expectedTarget },
    });
  });

  it('lets preview serve the build-time version assets unchanged', () => {
    const plugins = (
      (config as { plugins?: unknown[] }).plugins ?? []
    ).flat(Infinity) as Array<{
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
