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
    await router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: 's1' },
    });
    expect(router.state.location.pathname).toBe('/sessions/s1');
  });
});
