import type { RunSummary, ThreadSummary } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  groupThreads,
  managementStatusCounts,
  pathWithin,
  runTiming,
  sessionRouteTarget,
  threadActionAvailability,
  threadNeedsAttention,
} from './management';

const thread = (
  id: string,
  status: ThreadSummary['status'],
  updatedAt: number,
  pinnedAt?: number,
): ThreadSummary => ({
  id,
  projectId: 'p',
  title: id,
  status,
  updatedAt,
  ...(pinnedAt === undefined ? {} : { pinnedAt }),
});
const run = (
  id: string,
  threadId: string,
  status: RunSummary['status'],
  attempt = 1,
): RunSummary => ({
  id,
  threadId,
  checkoutId: `c-${id}`,
  attempt,
  mode: 'write',
  runtimeProvider: 'pi-server',
  status,
  createdAt: attempt,
  ...(status === 'failed' ? { error: 'failed' } : {}),
});

describe('management projections', () => {
  it('groups each thread into one deterministic shelf and prefers latest attempt', () => {
    const result = groupThreads(
      [
        thread('pinned', 'settled', 1, 10),
        thread('attention', 'failed', 3),
        thread('waiting', 'active', 2),
        thread('running', 'active', 2),
        thread('queued', 'queued', 4),
        thread('recent', 'settled', 5),
        thread('archived', 'archived', 6),
      ],
      [
        run('old', 'running', 'failed', 1),
        run('new', 'running', 'running', 2),
        run('waiting-run', 'waiting', 'waiting', 1),
      ],
    );
    expect(result.pinned.map((item) => item.id)).toEqual(['pinned']);
    expect(result.attention.map((item) => item.id)).toEqual([
      'attention',
      'waiting',
    ]);
    expect(result.running.map((item) => item.id)).toEqual(['running']);
    expect(result.queued.map((item) => item.id)).toEqual(['queued']);
    expect(result.recent.map((item) => item.id)).toEqual(['recent']);
    expect(result.archived.map((item) => item.id)).toEqual(['archived']);
    expect(Object.values(result).flat()).toHaveLength(7);
  });

  it('projects counts, stable timing, and owned-session route mapping', () => {
    const running = run('r', 't', 'running');
    expect(
      managementStatusCounts({
        threads: [
          thread('t', 'needs-input', 1),
          thread('waiting', 'active', 2, 9),
        ],
        runs: [
          running,
          run('q', 'q', 'queued'),
          run('f', 'f', 'failed'),
          run('waiting-run', 'waiting', 'waiting'),
        ],
      }),
    ).toMatchObject({
      active: 1,
      queued: 1,
      attention: 2,
      failed: 1,
      interrupted: 0,
    });
    expect(runTiming({ createdAt: 1_000, startedAt: 2_000 }, 62_000)).toBe(
      '1m elapsed',
    );
    expect(
      sessionRouteTarget('session-1', [
        { ...running, piSessionId: 'session-1' },
      ]),
    ).toBe('/threads/t');
    expect(sessionRouteTarget('legacy', [])).toBeUndefined();
    expect(
      threadNeedsAttention(thread('pinned-waiting', 'active', 1, 3), [
        run('pw', 'pinned-waiting', 'waiting'),
      ]),
    ).toBe(true);
    expect(pathWithin('/repo/worktree/file', '/repo/worktree')).toBe(true);
    expect(pathWithin('/repo/worktree-copy', '/repo/worktree')).toBe(false);
  });

  it('makes checkout action safety explicit', () => {
    const activeRun = run('active', 't', 'running');
    const terminalRun = run('terminal', 't', 'settled');
    const worktree = {
      id: 'c',
      projectId: 'p',
      kind: 'worktree' as const,
      path: '/tmp/c',
      status: 'dirty' as const,
      changedFileCount: 2,
      updatedAt: 1,
    };
    const main = { ...worktree, kind: 'main' as const };
    expect(threadActionAvailability(activeRun, worktree)).toMatchObject({
      canInterrupt: true,
      canReview: false,
      canMerge: false,
      canRetire: false,
    });
    expect(threadActionAvailability(terminalRun, worktree)).toMatchObject({
      canInterrupt: false,
      canReview: true,
      canMerge: true,
      canRetire: true,
    });
    expect(threadActionAvailability(terminalRun, main)).toMatchObject({
      canReview: false,
      canMerge: false,
      canRetire: false,
    });
    expect(
      threadActionAvailability(terminalRun, { ...worktree, status: 'retired' }),
    ).toMatchObject({
      canRetry: false,
      canReview: false,
      canMerge: false,
      canRetire: false,
    });
  });
});
