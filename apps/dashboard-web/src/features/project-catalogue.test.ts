import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import { projectCounts } from './project-catalogue';

describe('project catalogue', () => {
  it('counts only entities with the authoritative project identity', () => {
    const snapshot = {
      checkouts: [
        { id: 'checkout-1', projectId: 'project-1' },
        { id: 'checkout-2', projectId: 'project-2' },
      ],
      runtimes: [
        { runtimeId: 'runtime-1', projectId: 'project-1' },
        { runtimeId: 'runtime-unassigned', projectId: null },
      ],
      sessions: [
        { id: 'session-1', projectId: 'project-1' },
        { id: 'session-unassigned', projectId: null },
      ],
    } as unknown as BrowserSnapshot;

    expect(projectCounts(snapshot, 'project-1')).toEqual({
      checkouts: 1,
      runtimes: 1,
      sessions: 1,
    });
  });
});
