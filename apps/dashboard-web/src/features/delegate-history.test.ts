import type { DelegateHistoryResponse } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  composeDelegateHistory,
  delegateHistoryInvocationToStatus,
} from './delegate-history';

const history = {
  version: 1,
  sessionId: 'offline-session',
  groups: [
    {
      id: 'lineage-1',
      runId: 'run-2',
      lineageId: 'lineage-1',
      name: 'Historical worker',
      kind: 'background',
      state: 'success',
      createdAt: 1,
      finishedAt: 4,
      allowWrites: false,
      runCount: 2,
      runs: [
        {
          runId: 'run-1',
          lineageId: 'lineage-1',
          name: 'Historical worker',
          kind: 'background',
          state: 'error',
          createdAt: 1,
          finishedAt: 2,
          allowWrites: false,
          details: {
            task: 'first attempt',
            activities: [
              {
                type: 'tool',
                label: 'read source',
                name: 'read',
                arguments: { path: 'src/a.ts' },
                status: 'completed',
              },
            ],
            lifecycle: {
              reason: 'timeout',
              continuationUsable: true,
              writableBranchRetained: false,
              readOnlySnapshotRetained: true,
            },
            warnings: ['The first attempt timed out.'],
            truncated: true,
          },
        },
        {
          runId: 'run-2',
          lineageId: 'lineage-1',
          name: 'Historical worker',
          kind: 'background',
          state: 'success',
          createdAt: 3,
          finishedAt: 4,
          allowWrites: false,
          details: {
            task: 'second attempt',
            structuredResult: {
              valid: true,
              value: { ok: true },
              errors: [],
            },
            activities: [],
            truncated: false,
          },
        },
      ],
    },
  ],
} as unknown as DelegateHistoryResponse;

const liveRun3 = {
  id: 'live-lineage-row',
  runId: 'run-3',
  lineageId: 'lineage-1',
  name: 'Historical worker',
  kind: 'background' as const,
  state: 'running' as const,
  createdAt: 5,
  startedAt: 5,
  allowWrites: false,
};

describe('delegate history composition', () => {
  it('adapts durable details to the existing transcript inspector shape', () => {
    const row = delegateHistoryInvocationToStatus(history.groups[0].runs[0]);
    expect(row.runId).toBe('run-1');
    expect(row.transcript?.[0]).toMatchObject({
      type: 'task',
      text: 'first attempt',
    });
    expect(row.transcript?.[1]).toMatchObject({
      type: 'tool',
      name: 'read',
      arguments: { path: 'src/a.ts' },
    });
    expect(row.lifecycle?.reason).toBe('timeout');
    expect(row.warnings).toEqual(['The first attempt timed out.']);
    expect(row.transcriptTruncated).toBe(true);
  });

  it('keeps an active continuation run alongside queried runs in its lineage', () => {
    const model = composeDelegateHistory(history, [liveRun3]);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.runs.map((run) => run.id)).toEqual([
      'run-1',
      'run-2',
      'run-3',
    ]);
    expect(model.groups[0]?.section).toBe('active');
    expect(
      model.sections.find((section) => section.id === 'history')?.groups,
    ).toHaveLength(0);
  });

  it('marks omitted runs in a truncated lineage for inspection', () => {
    const incomplete = {
      ...history,
      truncated: true,
      groups: history.groups.map((group) => ({ ...group, truncated: true })),
    };
    const model = composeDelegateHistory(incomplete, []);
    expect(model.groups[0]?.row.historyIncomplete).toBe(true);
    expect(model.groups[0]?.row.transcriptTruncated).toBe(true);
    expect(model.groups[0]?.runs[0]?.row.historyIncomplete).toBe(true);
  });

  it('uses durable history without requiring a runtime surface', () => {
    const model = composeDelegateHistory(history, []);
    expect(model.groups[0]?.section).toBe('history');
    expect(
      model.sections.find((section) => section.id === 'history')?.groups,
    ).toHaveLength(1);
  });
});
