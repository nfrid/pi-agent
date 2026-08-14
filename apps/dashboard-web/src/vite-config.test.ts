import { describe, expect, it } from 'vitest';
import config from '../vite.config';

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
});
