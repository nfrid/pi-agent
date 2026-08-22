import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import { projectCounts } from './project-catalogue';
import {
  draftPendingPath,
  latestRunForThread,
  projectPendingPath,
} from './project-new-thread';

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

  it('selects the highest-attempt pending run', () => {
    const failedAttempt = {
      threadId: 'thread-1',
      attempt: 1,
      createdAt: 1,
      status: 'failed',
    };
    const runningAttempt = {
      threadId: 'thread-1',
      attempt: 2,
      createdAt: 2,
      status: 'running',
      runtimeId: 'runtime-2',
    };
    expect(
      latestRunForThread([runningAttempt, failedAttempt], 'thread-1'),
    ).toBe(runningAttempt);
    expect(
      latestRunForThread([failedAttempt, runningAttempt], 'thread-1')?.status,
    ).toBe('running');
  });

  it('builds encoded pending thread routes', () => {
    expect(projectPendingPath('project/one', 'thread/two')).toBe(
      '/projects/project%2Fone/new/pending/thread%2Ftwo',
    );
    expect(draftPendingPath('draft/one', 'thread/two')).toBe(
      '/drafts/draft%2Fone/pending/thread%2Ftwo',
    );
  });
});
