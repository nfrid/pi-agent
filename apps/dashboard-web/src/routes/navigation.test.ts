import { describe, expect, it } from 'vitest';
import { shouldUseDashboardViewTransition } from './navigation';

describe('dashboard view transition navigation policy', () => {
  it('enables transitions for eligible in-app navigation', () => {
    expect(
      shouldUseDashboardViewTransition({
        currentPath: '/projects/project-1',
        targetPath: '/runtimes/runtime-1',
        reducedMotion: false,
      }),
    ).toBe(true);
  });

  it.each([
    ['reduced motion', '/projects/project-1', '/runtimes/runtime-1', true],
    ['same path', '/sessions/one', '/sessions/one', false],
    [
      'same pathname with a search string',
      '/sessions/one',
      '/sessions/one?tab=details',
      false,
    ],
    ['legacy new current redirect', '/new', '/projects/project-1/new', false],
    ['legacy new target redirect', '/projects', '/new', false],
    ['current sessions route', '/sessions', '/projects', false],
    ['current session surface', '/sessions/one', '/projects', false],
    ['target sessions route', '/projects', '/sessions', false],
    ['target session surface', '/projects', '/sessions/one', false],
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
