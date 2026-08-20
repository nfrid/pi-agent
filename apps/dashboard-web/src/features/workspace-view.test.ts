import type {
  RuntimeSnapshot,
  SessionIndexEntry,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  sortWorkspaceRuntimes,
  sortWorkspaceSessions,
  summarizeWorkspace,
} from './workspace-view-model';

function runtime(
  runtimeId: string,
  overrides: Partial<
    Pick<RuntimeSnapshot, 'liveState' | 'online' | 'lastSeenAt'>
  > = {},
): RuntimeSnapshot {
  return {
    runtimeId,
    liveState: 'idle',
    online: true,
    lastSeenAt: 1,
    ...overrides,
  } as RuntimeSnapshot;
}

function session(id: string, updatedAt: number): SessionIndexEntry {
  return { id, file: `${id}.jsonl`, cwd: '/repo', updatedAt };
}

const workspace: WorkspaceTarget = {
  id: 'workspace-1',
  name: 'Repo',
  path: '/repo',
  canonicalPath: '/repo',
  source: 'directory',
  active: true,
};

describe('workspace detail projections', () => {
  it('sorts connected runtimes by attention state before stale offline runtimes', () => {
    const sorted = sortWorkspaceRuntimes([
      runtime('offline', {
        online: false,
        liveState: 'failed',
        lastSeenAt: 20,
      }),
      runtime('idle', { lastSeenAt: 30 }),
      runtime('failed', { liveState: 'failed', lastSeenAt: 10 }),
    ]);
    expect(sorted.map(({ runtimeId }) => runtimeId)).toEqual([
      'failed',
      'idle',
      'offline',
    ]);
  });

  it('sorts sessions newest first without mutating the input', () => {
    const input = [session('older', 10), session('newer', 20)];
    expect(sortWorkspaceSessions(input).map(({ id }) => id)).toEqual([
      'newer',
      'older',
    ]);
    expect(input.map(({ id }) => id)).toEqual(['older', 'newer']);
  });

  it('summarizes readiness and the newest session', () => {
    const sessions = [session('old', 10), session('new', 30)];
    expect(
      summarizeWorkspace(workspace, [runtime('live')], sessions),
    ).toMatchObject({
      readiness: 'ready',
      runtimeCount: 1,
      liveRuntimeCount: 1,
      sessionCount: 2,
      latestSession: sessions[1],
    });
    expect(
      summarizeWorkspace({ ...workspace, active: false }, [], []).readiness,
    ).toBe('dormant');
    expect(
      summarizeWorkspace(workspace, [runtime('offline', { online: false })], [])
        .readiness,
    ).toBe('offline');
  });
});
