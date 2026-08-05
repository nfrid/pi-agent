import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { dashboardRouteTree } from './App';

describe('dashboard route tree', () => {
  it('supports memory-history navigation without pathname parsing', async () => {
    const router = createRouter({
      routeTree: dashboardRouteTree,
      history: createMemoryHistory({ initialEntries: ['/new'] }),
    });
    await router.load();
    expect(router.state.location.pathname).toBe('/new');
    for (const path of ['/workspaces', '/sessions', '/inbox'] as const) {
      await router.navigate({ to: path });
      expect(router.state.location.pathname).toBe(path);
    }
    await router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: 's1' },
    });
    expect(router.state.location.pathname).toBe('/sessions/s1');
  });
});
