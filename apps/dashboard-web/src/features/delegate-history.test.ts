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
            response: 'The first durable response.',
            error: 'The first durable error.',
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
            response: 'The second durable response.',
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
    expect(row.transcript).toContainEqual(
      expect.objectContaining({
        type: 'assistant',
        text: 'The first durable response.',
      }),
    );
    expect(row.transcript).toContainEqual(
      expect.objectContaining({
        type: 'error',
        text: 'The first durable error.',
      }),
    );
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

  it('reconciles a settled live run with a queued history launch by job ID', () => {
    const queuedHistory = {
      ...history,
      groups: [
        {
          ...history.groups[0],
          runId: 'launch-run',
          state: 'queued' as const,
          runCount: 1,
          runs: [
            {
              ...history.groups[0].runs[0],
              runId: 'launch-run',
              state: 'queued' as const,
              jobId: 'job-review',
            },
          ],
        },
      ],
    };
    const model = composeDelegateHistory(queuedHistory, [
      {
        ...liveRun3,
        runId: 'terminal-run',
        state: 'success',
        jobId: 'job-review',
      },
    ]);
    expect(model.groups[0]?.runs.map((run) => run.id)).toEqual([
      'terminal-run',
    ]);
    expect(model.groups[0]?.row.state).toBe('success');
    expect(model.groups[0]?.section).toBe('recent');
  });

  it('keeps each continuation run option on its own transcript segment', () => {
    const live = {
      ...liveRun3,
      runCount: 3,
      transcript: [
        {
          id: '1:old',
          type: 'assistant' as const,
          label: 'Response',
          text: 'run one',
          run: 1,
        },
        {
          id: '2:old',
          type: 'assistant' as const,
          label: 'Response',
          text: 'run two',
          run: 2,
        },
        {
          id: '3:new',
          type: 'assistant' as const,
          label: 'Response',
          text: 'run three',
          run: 3,
        },
      ],
    };
    const model = composeDelegateHistory(
      {
        ...history,
        groups: [
          {
            ...history.groups[0],
            runId: 'run-3',
            runCount: 3,
            runs: [
              ...history.groups[0].runs,
              {
                runId: 'run-3',
                lineageId: 'lineage-1',
                name: 'Historical worker',
                kind: 'background' as const,
                state: 'running' as const,
                createdAt: 5,
                allowWrites: false,
              },
            ],
          },
        ],
      },
      [live],
    );
    const runs = model.groups[0]?.runs ?? [];
    const runOneText = runs[0]?.row.transcript?.map((entry) => entry.text);
    const runTwoText = runs[1]?.row.transcript?.map((entry) => entry.text);
    expect(runOneText).toContain('first attempt');
    expect(runOneText).not.toContain('run two');
    expect(runOneText).not.toContain('run three');
    expect(runTwoText).toContain('second attempt');
    expect(runTwoText).not.toContain('run one');
    expect(runTwoText).not.toContain('run three');
    expect(runs[2]?.row.transcript).toEqual([
      expect.objectContaining({ text: 'run three', run: 3 }),
    ]);
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

  it('reuses the continuation child session across historical runs', () => {
    const model = composeDelegateHistory(
      {
        ...history,
        groups: [
          {
            ...history.groups[0],
            sessionId: 'child-session-shared',
            runs: [
              history.groups[0].runs[0],
              {
                ...history.groups[0].runs[1],
                sessionId: 'child-session-shared',
              },
            ],
          },
        ],
      },
      [],
    );
    expect(model.groups[0]?.row.sessionId).toBe('child-session-shared');
    expect(model.groups[0]?.runs.map((run) => run.row.sessionId)).toEqual([
      'child-session-shared',
      'child-session-shared',
    ]);
  });

  it('uses durable history without requiring a runtime surface', () => {
    const model = composeDelegateHistory(history, []);
    expect(model.groups[0]?.section).toBe('history');
    expect(
      model.sections.find((section) => section.id === 'history')?.groups,
    ).toHaveLength(1);
  });

  it('suppresses standalone wake groups and annotates their single real reference', () => {
    const model = composeDelegateHistory(
      {
        version: 2,
        sessionId: 'offline-session',
        groups: [
          {
            id: 'delegate-lineage',
            runId: 'delegate-run',
            lineageId: 'delegate-lineage',
            name: 'Review worker',
            kind: 'background',
            state: 'running',
            createdAt: 1,
            allowWrites: false,
            runCount: 1,
            runs: [
              {
                runId: 'delegate-run',
                lineageId: 'delegate-lineage',
                name: 'Review worker',
                kind: 'background',
                state: 'running',
                createdAt: 1,
                allowWrites: false,
                workflow: {
                  logicalId: 'review',
                  attempt: 1,
                  identity: 'review@1',
                  state: 'running',
                  dependencies: [],
                  createdAt: 1,
                  scheduledAt: 1,
                },
              },
            ],
          },
          {
            id: 'wake-lineage',
            runId: 'wake-run',
            lineageId: 'wake:review-ready',
            name: 'Wake review-ready',
            kind: 'background',
            state: 'running',
            createdAt: 2,
            allowWrites: false,
            runCount: 1,
            wake: {
              id: 'review-ready',
              state: 'pending',
              references: ['review@1'],
              createdAt: 2,
              revision: 1,
              dispatchAttempts: 0,
            },
            runs: [
              {
                runId: 'wake-run',
                lineageId: 'wake:review-ready',
                name: 'Wake review-ready',
                kind: 'background',
                state: 'running',
                createdAt: 2,
                allowWrites: false,
                wake: {
                  id: 'review-ready',
                  state: 'pending',
                  references: ['review@1'],
                  createdAt: 2,
                  revision: 1,
                  dispatchAttempts: 0,
                },
              },
            ],
          },
        ],
      } as DelegateHistoryResponse,
      [],
    );
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.row.workflow?.identity).toBe('review@1');
    expect(model.groups[0]?.row.wake?.id).toBe('review-ready');
    expect(model.groups[0]?.row.wake?.references).toEqual(['review@1']);
    expect(model.groups[0]?.row.runCount).toBe(1);
    expect(model.wakes).toHaveLength(1);
  });

  it('does not regress a durable entered wake to stale live pending state', () => {
    const enteredWake = {
      id: 'old-fan-in',
      state: 'entered' as const,
      references: ['one@1', 'two@1'],
      createdAt: 1,
      enteredAt: 2,
      revision: 4,
      dispatchAttempts: 1,
    };
    const model = composeDelegateHistory(
      {
        version: 2,
        sessionId: 'stale-live-session',
        groups: [
          {
            id: 'wake-lineage',
            runId: 'wake-run',
            lineageId: 'wake:old-fan-in',
            name: 'Wake old-fan-in',
            kind: 'background',
            state: 'success',
            createdAt: 1,
            allowWrites: false,
            runCount: 1,
            wake: enteredWake,
            runs: [],
          },
        ],
      } as DelegateHistoryResponse,
      [],
      [
        {
          id: 'old-fan-in',
          state: 'pending',
          references: ['one@1', 'two@1'],
          waitingFor: ['one@1', 'two@1'],
          createdAt: 1,
        },
      ],
    );

    expect(model.wakes).toEqual([enteredWake]);
  });

  it('reconciles a workflow placeholder with a unique live run before wake annotation', () => {
    const placeholderWorkflow = {
      logicalId: 'impl-inline-wake-ui',
      attempt: 1,
      identity: 'impl-inline-wake-ui@1',
      state: 'running' as const,
      dependencies: [],
      createdAt: 1,
      scheduledAt: 1,
    };
    const model = composeDelegateHistory(
      {
        version: 2,
        sessionId: 'offline-session',
        groups: [
          {
            id: 'impl-placeholder',
            runId: 'impl-placeholder-run',
            lineageId: 'impl-inline-wake-ui',
            name: 'impl-inline-wake-ui',
            kind: 'background',
            state: 'running',
            createdAt: 1,
            allowWrites: false,
            workflow: placeholderWorkflow,
            runCount: 1,
            runs: [
              {
                runId: 'impl-placeholder-run',
                lineageId: 'impl-inline-wake-ui',
                name: 'impl-inline-wake-ui',
                kind: 'background',
                state: 'running',
                createdAt: 1,
                allowWrites: false,
                workflow: placeholderWorkflow,
              },
            ],
          },
          {
            id: 'wake-lineage',
            runId: 'wake-run',
            lineageId: 'wake:impl-ready',
            name: 'Wake impl-ready',
            kind: 'background',
            state: 'running',
            createdAt: 2,
            allowWrites: false,
            runCount: 1,
            wake: {
              id: 'impl-ready',
              state: 'pending',
              references: ['impl-inline-wake-ui@1'],
              createdAt: 2,
              revision: 1,
              dispatchAttempts: 0,
            },
            runs: [],
          },
        ],
      } as DelegateHistoryResponse,
      [
        {
          id: 'actual-live',
          runId: 'actual-live-run',
          lineageId: 'actual-live-lineage',
          name: 'Actual implementation worker',
          kind: 'background',
          state: 'running',
          createdAt: 3,
          allowWrites: true,
          workflow: { ...placeholderWorkflow, state: 'running' },
        },
      ],
    );
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.row.runId).toBe('actual-live-run');
    expect(model.groups[0]?.row.name).toBe('Actual implementation worker');
    expect(model.groups[0]?.row.runCount).toBe(1);
    expect(model.groups[0]?.row.wake?.id).toBe('impl-ready');

    const ambiguous = composeDelegateHistory(
      {
        version: 2,
        sessionId: 'offline-session',
        groups: [
          {
            id: 'impl-placeholder',
            runId: 'impl-placeholder-run',
            lineageId: 'impl-inline-wake-ui',
            name: 'impl-inline-wake-ui',
            kind: 'background',
            state: 'running',
            createdAt: 1,
            allowWrites: false,
            workflow: placeholderWorkflow,
            runCount: 1,
            runs: [
              {
                runId: 'impl-placeholder-run',
                lineageId: 'impl-inline-wake-ui',
                name: 'impl-inline-wake-ui',
                kind: 'background',
                state: 'running',
                createdAt: 1,
                allowWrites: false,
                workflow: placeholderWorkflow,
              },
            ],
          },
        ],
      } as DelegateHistoryResponse,
      [
        {
          id: 'actual-live',
          runId: 'actual-live-run',
          lineageId: 'actual-live-lineage',
          name: 'Actual implementation worker',
          kind: 'background',
          state: 'running',
          createdAt: 3,
          allowWrites: true,
          workflow: { ...placeholderWorkflow, state: 'running' },
        },
        {
          id: 'other-live',
          runId: 'other-live-run',
          lineageId: 'other-live-lineage',
          name: 'Other implementation worker',
          kind: 'background',
          state: 'running',
          createdAt: 3,
          allowWrites: true,
          workflow: { ...placeholderWorkflow, state: 'running' },
        },
      ],
    );
    expect(ambiguous.groups).toHaveLength(3);
  });

  it('keeps unresolved multi-reference wakes as conditions, not delegate groups', () => {
    const model = composeDelegateHistory(
      {
        version: 2,
        sessionId: 'offline-session',
        groups: [
          {
            id: 'wake-lineage',
            runId: 'wake-run',
            lineageId: 'wake:all-ready',
            name: 'Wake all-ready',
            kind: 'background',
            state: 'running',
            createdAt: 2,
            allowWrites: false,
            runCount: 1,
            wake: {
              id: 'all-ready',
              state: 'pending',
              references: ['one@1', 'two@1'],
              createdAt: 2,
              revision: 1,
              dispatchAttempts: 0,
            },
            runs: [],
          },
        ],
      } as DelegateHistoryResponse,
      [],
    );
    expect(model.groups).toHaveLength(0);
    expect(model.wakes[0]?.references).toEqual(['one@1', 'two@1']);
  });
});
