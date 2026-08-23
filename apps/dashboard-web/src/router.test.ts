import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { dashboardRouteTree } from './App';

describe('dashboard route tree', () => {
  it('supports memory-history navigation without pathname parsing', async () => {
    const router = createRouter({
      routeTree: dashboardRouteTree,
      history: createMemoryHistory({
        initialEntries: ['/projects/project-1/new'],
      }),
    });
    await router.load();
    expect(router.state.location.pathname).toBe('/projects/project-1/new');
    for (const path of ['/projects'] as const) {
      await router.navigate({ to: path });
      expect(router.state.location.pathname).toBe(path);
    }
    await router.navigate({
      to: '/projects/$projectId',
      params: { projectId: 'project-1' },
    });
    expect(router.state.location.pathname).toBe('/projects/project-1');
    await router.navigate({
      to: '/projects/$projectId/new',
      params: { projectId: 'project-1' },
    });
    expect(router.state.location.pathname).toBe('/projects/project-1/new');
    await router.navigate({
      to: '/projects/$projectId/new/pending/$threadId',
      params: { projectId: 'project-1', threadId: 'thread-1' },
    });
    expect(router.state.location.pathname).toBe(
      '/projects/project-1/new/pending/thread-1',
    );
    await router.navigate({
      to: '/drafts/$draftId',
      params: { draftId: 'draft-1' },
    });
    expect(router.state.location.pathname).toBe('/drafts/draft-1');
    await router.navigate({
      to: '/drafts/$draftId/pending/$threadId',
      params: { draftId: 'draft-1', threadId: 'thread-1' },
    });
    expect(router.state.location.pathname).toBe(
      '/drafts/draft-1/pending/thread-1',
    );
    await router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: 's1' },
    });
    expect(router.state.location.pathname).toBe('/sessions/s1');
  });
});
