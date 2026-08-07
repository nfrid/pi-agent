import type { RunSummary, ThreadSummary } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  groupThreads,
  managementStatusCounts,
  runTiming,
  sessionRouteTarget,
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
        thread('running', 'active', 2),
        thread('queued', 'queued', 4),
        thread('recent', 'settled', 5),
        thread('archived', 'archived', 6),
      ],
      [run('old', 'running', 'failed', 1), run('new', 'running', 'running', 2)],
    );
    expect(result.pinned.map((item) => item.id)).toEqual(['pinned']);
    expect(result.attention.map((item) => item.id)).toEqual(['attention']);
    expect(result.running.map((item) => item.id)).toEqual(['running']);
    expect(result.queued.map((item) => item.id)).toEqual(['queued']);
    expect(result.recent.map((item) => item.id)).toEqual(['recent']);
    expect(result.archived.map((item) => item.id)).toEqual(['archived']);
    expect(Object.values(result).flat()).toHaveLength(6);
  });

  it('projects counts, stable timing, and owned-session route mapping', () => {
    const running = run('r', 't', 'running');
    expect(
      managementStatusCounts({
        threads: [thread('t', 'needs-input', 1)],
        runs: [running, run('q', 'q', 'queued'), run('f', 'f', 'failed')],
      }),
    ).toMatchObject({ active: 1, queued: 1, attention: 1, failed: 1 });
    expect(runTiming({ createdAt: 1_000, startedAt: 2_000 }, 62_000)).toBe(
      '1m elapsed',
    );
    expect(
      sessionRouteTarget('session-1', [
        { ...running, piSessionId: 'session-1' },
      ]),
    ).toBe('/threads/t');
    expect(sessionRouteTarget('legacy', [])).toBeUndefined();
  });
});
