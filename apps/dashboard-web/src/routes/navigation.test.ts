import { describe, expect, it } from 'vitest';
import { shouldUseDashboardViewTransition } from './navigation';

describe('dashboard view transition navigation policy', () => {
  it('enables transitions for eligible in-app navigation', () => {
    expect(
      shouldUseDashboardViewTransition({
        currentPath: '/workspaces/workspace-1',
        targetPath: '/runtimes/runtime-1',
        reducedMotion: false,
      }),
    ).toBe(true);
  });

  it.each([
    ['reduced motion', '/workspaces/workspace-1', '/runtimes/runtime-1', true],
    ['same path', '/sessions/one', '/sessions/one', false],
    [
      'same pathname with a search string',
      '/sessions/one',
      '/sessions/one?tab=details',
      false,
    ],
    [
      'legacy new current redirect',
      '/new',
      '/workspaces/workspace-1/new',
      false,
    ],
    ['legacy new target redirect', '/workspaces', '/new', false],
    ['current sessions route', '/sessions', '/workspaces', false],
    ['current session surface', '/sessions/one', '/workspaces', false],
    ['target sessions route', '/workspaces', '/sessions', false],
    ['target session surface', '/workspaces', '/sessions/one', false],
  ])('opts out for %s', (_reason, currentPath, targetPath, reducedMotion) => {
    expect(
      shouldUseDashboardViewTransition({
        currentPath,
        targetPath,
        reducedMotion,
      }),
    ).toBe(false);
  });
});
