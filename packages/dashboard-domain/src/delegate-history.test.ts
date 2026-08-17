import {
  parseDelegateHistoryResponse,
  parseDelegateHistoryRunDetailResponse,
} from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  delegateHistoryFromBranch,
  delegateHistoryRunDetailFromBranch,
  projectDelegateHistoryEntry,
} from './delegate-history.js';

function oldRun(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Review',
    task: 'inspect the change',
    exitCode: 0,
    state: 'success',
    activities: [],
    ...overrides,
  };
}

describe('delegate history adapter', () => {
  it('round-trips explicit child session identity without deriving legacy values', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      {
        type: 'message',
        id: 'current-result',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            mode: 'single',
            runs: [
              oldRun({
                runId: 'run-current',
                lineageId: 'lineage-current',
                sessionId: 'child-session-current',
              }),
            ],
          },
        },
      },
      {
        type: 'message',
        id: 'legacy-result',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: { mode: 'single', runs: [oldRun()] },
        },
      },
    ];
    const response = delegateHistoryFromBranch('parent-1', branch);
    const current = response.groups.find(
      (group) => group.runId === 'run-current',
    );
    expect(current).toMatchObject({
      sessionId: 'child-session-current',
      runs: [{ sessionId: 'child-session-current' }],
    });
    const legacy = response.groups.find(
      (group) => group.runId !== 'run-current',
    );
    expect(legacy).not.toHaveProperty('sessionId');
    expect(legacy?.runs[0]).not.toHaveProperty('sessionId');
    const detail = delegateHistoryRunDetailFromBranch(
      'parent-1',
      branch,
      'run-current',
      'lineage-current',
    );
    expect(detail.run.sessionId).toBe('child-session-current');
    expect(parseDelegateHistoryResponse(response)).toEqual(response);
    expect(parseDelegateHistoryRunDetailResponse(detail)).toEqual(detail);
  });

  it('extracts foreground and background summary metadata from the selected branch', () => {
    const response = delegateHistoryFromBranch(
      'parent-1',
      [
        { type: 'session', id: 'parent-1' },
        {
          type: 'message',
          id: 'foreground-result',
          message: {
            role: 'toolResult',
            toolName: 'delegate',
            details: {
              mode: 'single',
              runs: [oldRun({ continuation: 'legacy-token' })],
            },
          },
        },
        {
          type: 'message',
          id: 'background-result',
          message: {
            customType: 'delegate-job-result',
            details: {
              jobs: [
                {
                  id: 'job-1',
                  name: 'Background review',
                  state: 'success',
                  runs: [oldRun({ continuation: 'legacy-token' })],
                },
              ],
            },
          },
        },
      ],
      'background-result',
    );

    expect(response.leafId).toBe('background-result');
    expect(response.groups).toHaveLength(1);
    expect(response.groups[0]).toMatchObject({
      name: 'Review',
      lineageId: 'dl-dea8c20f3c21ef45',
      runCount: 2,
    });
    expect(response.groups[0]?.runs[0]?.runId).not.toBe(
      response.groups[0]?.runs[1]?.runId,
    );
    expect(response.groups[0]?.runs[1]).toMatchObject({
      kind: 'background',
      jobId: 'job-1',
      task: 'inspect the change',
    });
    expect(response.groups[0]?.runs[1]).not.toHaveProperty('details');
    expect(parseDelegateHistoryResponse(response)).toEqual(response);
    const detail = delegateHistoryRunDetailFromBranch(
      'parent-1',
      [
        { type: 'session', id: 'parent-1' },
        {
          type: 'message',
          id: 'background-result',
          message: {
            customType: 'delegate-job-result',
            details: {
              jobs: [
                {
                  id: 'job-1',
                  name: 'Background review',
                  state: 'success',
                  runs: [oldRun({ continuation: 'legacy-token' })],
                },
              ],
            },
          },
        },
      ],
      response.groups[0]?.runs[1]?.runId ?? '',
      response.groups[0]?.runs[1]?.lineageId,
      'background-result',
    );
    expect(
      parseDelegateHistoryRunDetailResponse(detail).run.details,
    ).toMatchObject({
      task: 'inspect the change',
      truncated: false,
    });
  });

  it('collapses modern background launch placeholders onto terminal runs', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      {
        type: 'message',
        id: 'launch-1',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            runs: [
              oldRun({
                runId: 'run-modern',
                lineageId: 'lineage-modern',
                backgroundJobId: 'job-modern',
                state: 'queued',
                activities: [],
              }),
            ],
          },
        },
      },
      {
        type: 'custom_message',
        id: 'completion-1',
        message: {
          customType: 'delegate-job-result',
          details: {
            jobs: [
              {
                id: 'job-modern',
                state: 'success',
                runs: [
                  oldRun({
                    runId: 'run-modern',
                    lineageId: 'lineage-modern',
                    backgroundJobId: 'job-modern',
                    state: 'success',
                    messages: [
                      {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'terminal response' }],
                      },
                    ],
                    activities: [
                      {
                        type: 'tool',
                        label: 'terminal activity',
                        transcriptText: 'terminal activity output',
                        status: 'completed',
                      },
                    ],
                  }),
                ],
              },
            ],
          },
        },
      },
    ];

    const response = delegateHistoryFromBranch('parent-1', branch);
    expect(response.groups[0]?.runs).toHaveLength(1);
    expect(response.groups[0]?.runs[0]).toMatchObject({
      runId: 'run-modern',
      state: 'success',
      jobId: 'job-modern',
    });
    const detail = delegateHistoryRunDetailFromBranch(
      'parent-1',
      branch,
      'run-modern',
      'lineage-modern',
    );
    expect(detail.run.details).toMatchObject({
      response: 'terminal response',
      activities: [{ text: 'terminal activity output' }],
    });
  });

  it('reconciles settled completion evidence by background job ID', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      {
        type: 'message',
        id: 'launch-legacy',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            runs: [
              oldRun({
                runId: 'launch-run',
                lineageId: 'launch-lineage',
                backgroundJobId: 'job-legacy',
                state: 'queued',
                task: 'Phase 3.5 regression review',
              }),
            ],
          },
        },
      },
      {
        type: 'custom_message',
        id: 'completion-legacy',
        message: {
          customType: 'delegate-job-result',
          details: {
            jobs: [
              {
                id: 'job-legacy',
                state: 'success',
                // Older completion records can omit the run's backgroundJobId
                // and use a distinct run identity.
                runs: [
                  oldRun({
                    runId: 'terminal-run',
                    lineageId: 'terminal-lineage',
                    state: 'success',
                    messages: [
                      {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'review complete' }],
                      },
                    ],
                  }),
                ],
              },
            ],
          },
        },
      },
    ];

    const response = delegateHistoryFromBranch('parent-1', branch);
    expect(response.groups).toHaveLength(1);
    expect(response.groups[0]).toMatchObject({
      lineageId: 'terminal-lineage',
      state: 'success',
      runs: [
        {
          runId: 'terminal-run',
          state: 'success',
          jobId: 'job-legacy',
        },
      ],
    });
  });

  it('uses settled job metadata when completion runs are not persisted', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      {
        type: 'message',
        id: 'launch-without-terminal',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            runs: [
              oldRun({
                runId: 'run-without-terminal',
                lineageId: 'lineage-without-terminal',
                backgroundJobId: 'job-without-terminal',
                state: 'queued',
              }),
            ],
          },
        },
      },
      {
        type: 'custom_message',
        id: 'completion-without-run',
        message: {
          customType: 'delegate-job-result',
          details: {
            jobs: [
              {
                id: 'job-without-terminal',
                name: 'Completed review',
                state: 'success',
                settledAt: 42,
              },
            ],
          },
        },
      },
    ];

    const projectedCompletion = projectDelegateHistoryEntry(branch[2], {
      sessionId: 'parent-1',
    }).entry;
    const response = delegateHistoryFromBranch('parent-1', [
      branch[0],
      branch[1],
      projectedCompletion,
    ]);
    expect(response.groups).toHaveLength(1);
    expect(response.groups[0]?.runs).toHaveLength(1);
    expect(response.groups[0]?.runs[0]).toMatchObject({
      runId: 'run-without-terminal',
      lineageId: 'lineage-without-terminal',
      state: 'success',
      finishedAt: 42,
      jobId: 'job-without-terminal',
    });
    const detail = delegateHistoryRunDetailFromBranch(
      'parent-1',
      [branch[0], branch[1], projectedCompletion],
      'run-without-terminal',
      'lineage-without-terminal',
    );
    expect(detail.run).toMatchObject({
      state: 'success',
      details: { task: 'inspect the change', truncated: false },
    });
  });

  it('keeps a genuinely queued launch active without settlement evidence', () => {
    const response = delegateHistoryFromBranch('parent-1', [
      { type: 'session', id: 'parent-1' },
      {
        type: 'message',
        id: 'still-queued',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            runs: [
              oldRun({
                runId: 'still-queued-run',
                lineageId: 'still-queued-lineage',
                backgroundJobId: 'still-queued-job',
                state: 'queued',
              }),
            ],
          },
        },
      },
    ]);
    expect(response.groups[0]?.runs).toHaveLength(1);
    expect(response.groups[0]?.runs[0]).toMatchObject({
      runId: 'still-queued-run',
      state: 'queued',
    });
  });

  it('bounds runs per lineage and marks omitted records', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      ...Array.from({ length: 130 }, (_, index) => ({
        type: 'message',
        id: `result-${index}`,
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            mode: 'single',
            runs: [oldRun({ continuation: 'legacy-token' })],
          },
        },
      })),
    ];
    const response = delegateHistoryFromBranch('parent-1', branch);
    expect(response.truncated).toBe(true);
    expect(response.groups).toHaveLength(1);
    expect(response.groups[0]).toMatchObject({
      runCount: 128,
      truncated: true,
    });
    expect(parseDelegateHistoryResponse(response)).toEqual(response);
  });

  it('trims oldest oversized continuations while retaining the newest run', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      ...Array.from({ length: 8 }, (_, index) => ({
        type: 'message',
        id: `result-${index}`,
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            mode: 'single',
            runs: [
              oldRun({
                name: `Continuation ${index}`,
                task: 'x'.repeat(20_000),
                continuation: `continuation-${index}`,
                state: 'success',
                startedAt: index + 10,
                finishedAt: index + 11,
                routing: { route: `route-${index}` },
                backgroundJobId: `job-${index}`,
              }),
            ],
          },
        },
      })),
      {
        type: 'message',
        id: 'result-8',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            mode: 'single',
            runs: [
              oldRun({
                name: 'Continuation 7 current',
                task: 'x'.repeat(20_000),
                continuation: 'continuation-7',
                state: 'error',
                startedAt: 18,
                finishedAt: 19,
                routing: { route: 'route-current' },
                backgroundJobId: 'job-current',
              }),
            ],
          },
        },
      },
    ];

    const response = delegateHistoryFromBranch('parent-1', branch);
    const newest = response.groups.at(-1);
    expect(response.truncated).toBe(true);
    expect(newest).toMatchObject({
      name: 'Continuation 7 current',
      runId: newest?.runs.at(-1)?.runId,
      state: 'error',
      createdAt: 17,
      startedAt: 18,
      finishedAt: 19,
      jobId: 'job-current',
      route: 'route-current',
      runCount: 2,
    });
    expect(newest?.runs).toHaveLength(2);
    expect(newest?.runs[0]?.task).toBe('x'.repeat(20_000));
    expect(parseDelegateHistoryResponse(response)).toEqual(response);
  });

  it('bounds selected detail payloads and marks omitted fields', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      {
        type: 'message',
        id: 'result-large',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            mode: 'single',
            runs: [oldRun({ task: 'task '.repeat(20_000) })],
          },
        },
      },
    ];
    const response = delegateHistoryFromBranch('parent-1', branch);
    const detail = delegateHistoryRunDetailFromBranch(
      'parent-1',
      branch,
      response.groups[0]?.runs[0]?.runId ?? '',
      response.groups[0]?.runs[0]?.lineageId,
    );
    const details = detail.run.details;
    expect(details.truncated).toBe(true);
    expect(details.task?.length).toBeLessThanOrEqual(20_000);
    expect(parseDelegateHistoryResponse(response)).toEqual(response);
  });

  it('projects selected public response and errors without stderr', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      {
        type: 'message',
        id: 'result-public-details',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            mode: 'single',
            runs: [
              oldRun({
                messages: [
                  {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Answer one.' }],
                  },
                  {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Answer two.' }],
                  },
                ],
                errorMessage: 'The runner failed safely.',
                stderr: 'private stderr must not cross the boundary',
              }),
            ],
          },
        },
      },
    ];
    const response = delegateHistoryFromBranch('parent-1', branch);
    const detail = delegateHistoryRunDetailFromBranch(
      'parent-1',
      branch,
      response.groups[0]?.runs[0]?.runId ?? '',
      response.groups[0]?.runs[0]?.lineageId,
    );
    expect(detail.run.details).toMatchObject({
      response: 'Answer one.\nAnswer two.',
      error: 'The runner failed safely.',
    });
    expect(JSON.stringify(detail)).not.toContain('private stderr');
  });

  it('projects oversized persisted entries before summary and detail scans', () => {
    const entry = {
      type: 'message',
      id: 'oversized-result',
      message: {
        role: 'toolResult',
        toolName: 'delegate',
        details: {
          runs: [
            oldRun({
              runId: 'oversized-run',
              lineageId: 'oversized-lineage',
              task: 'inspect '.repeat(20_000),
              rawPayload: 'raw payload must not be retained '.repeat(20_000),
              activities: [
                {
                  type: 'tool',
                  label: 'large activity',
                  transcriptText: 'public activity '.repeat(10_000),
                },
              ],
            }),
          ],
        },
      },
    };
    const summaryProjection = projectDelegateHistoryEntry(entry, {
      sessionId: 'parent-1',
    });
    expect(JSON.stringify(summaryProjection.entry).length).toBeLessThan(
      512 * 1024,
    );
    expect(JSON.stringify(summaryProjection.entry)).not.toContain(
      'raw payload must not be retained',
    );
    const summary = delegateHistoryFromBranch('parent-1', [
      { type: 'session', id: 'parent-1' },
      summaryProjection.entry,
    ]);
    expect(summary.groups[0]?.runs[0]).toMatchObject({
      runId: 'oversized-run',
      lineageId: 'oversized-lineage',
    });
    const detailProjection = projectDelegateHistoryEntry(entry, {
      sessionId: 'parent-1',
      detailRunId: 'oversized-run',
    });
    const detail = delegateHistoryRunDetailFromBranch(
      'parent-1',
      [detailProjection.entry],
      'oversized-run',
      'oversized-lineage',
    );
    expect(detail.run.details).toMatchObject({
      activities: [{ text: expect.stringContaining('public activity') }],
      truncated: true,
    });
    expect(detail.run.details.task?.length).toBeLessThanOrEqual(20_000);
    expect(JSON.stringify(detail)).not.toContain(
      'raw payload must not be retained',
    );
  });

  it('keeps new identities and gives old standalone runs distinct stable IDs', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      {
        type: 'message',
        id: 'result-a',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            mode: 'single',
            runs: [
              oldRun(),
              { ...oldRun(), runId: 'new-run', lineageId: 'new-lineage' },
            ],
          },
        },
      },
      {
        type: 'message',
        id: 'result-b',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: { mode: 'single', runs: [oldRun()] },
        },
      },
    ];
    const first = delegateHistoryFromBranch('parent-1', branch);
    const second = delegateHistoryFromBranch('parent-1', branch);
    const allRuns = first.groups.flatMap((group) => group.runs);
    const repeatRuns = second.groups.flatMap((group) => group.runs);

    expect(allRuns[1]).toMatchObject({
      runId: 'new-run',
      lineageId: 'new-lineage',
    });
    expect(allRuns[0]?.runId).toBe(repeatRuns[0]?.runId);
    expect(allRuns[0]?.runId).not.toBe(allRuns[2]?.runId);
    expect(allRuns[0]?.lineageId).toBe(allRuns[0]?.runId);
  });

  it('projects durable workflow snapshots after reload without secret payloads', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      {
        type: 'custom',
        id: 'workflow-entry-1',
        customType: 'delegate-workflow:v1',
        data: {
          version: 1,
          kind: 'snapshot',
          state: {
            version: 1,
            attempts: [
              {
                logicalId: 'later',
                attempt: 1,
                identity: 'later@1',
                state: 'scheduled',
                dependencies: ['gate@1'],
                waitingFor: ['gate@1'],
                createdAt: 1,
                scheduledAt: 1,
                reason: 'waiting for dependency',
              },
            ],
            report: 'secret report must not appear',
          },
        },
      },
      {
        type: 'custom',
        id: 'workflow-entry-2',
        customType: 'delegate-workflow:v1',
        data: {
          version: 1,
          kind: 'snapshot',
          state: {
            version: 1,
            attempts: [
              {
                logicalId: 'later',
                attempt: 1,
                identity: 'later@1',
                state: 'success',
                dependencies: ['gate@1'],
                waitingFor: [],
                createdAt: 1,
                scheduledAt: 1,
                settledAt: 3,
                route: 'review',
              },
            ],
          },
        },
      },
    ];
    const response = delegateHistoryFromBranch('parent-1', branch);
    expect(response.groups[0]).toMatchObject({
      lineageId: 'later',
      state: 'success',
      workflow: { identity: 'later@1', dependencies: ['gate@1'] },
    });
    expect(response.groups[0]?.runs[0]).not.toHaveProperty('jobId');
    expect(JSON.stringify(response)).not.toContain('secret report');
  });

  it('folds deltas after v1 snapshots and keeps owner plus identity exact', () => {
    const attempt = (
      ownerBranchId: string,
      state: string,
      settledAt?: number,
    ) => ({
      ownerBranchId,
      logicalId: 'review',
      attempt: 1,
      identity: 'review@1',
      state,
      dependencies: [],
      waitingFor: [],
      createdAt: 1,
      scheduledAt: 1,
      ...(settledAt === undefined ? {} : { settledAt }),
    });
    const branch = [
      { type: 'session', id: 'parent-1' },
      {
        type: 'custom',
        id: 'workflow-snapshot',
        customType: 'delegate-workflow:v1',
        data: {
          version: 1,
          kind: 'snapshot',
          state: { version: 1, attempts: [attempt('owner-a', 'scheduled')] },
        },
      },
      {
        type: 'custom',
        id: 'workflow-delta-b',
        customType: 'delegate-workflow:v1',
        data: {
          version: 1,
          kind: 'delta',
          state: { version: 1, attempts: [attempt('owner-b', 'scheduled')] },
        },
      },
      {
        type: 'custom',
        id: 'workflow-delta-a',
        customType: 'delegate-workflow:v1',
        data: {
          version: 1,
          kind: 'delta',
          state: {
            version: 1,
            attempts: [attempt('owner-a', 'success', 4)],
          },
        },
      },
    ];
    const response = delegateHistoryFromBranch('parent-1', branch);
    expect(response.groups).toHaveLength(2);
    expect(
      response.groups.map((group) => group.workflow?.ownerBranchId),
    ).toEqual(expect.arrayContaining(['owner-a', 'owner-b']));
    expect(
      response.groups.find(
        (group) => group.workflow?.ownerBranchId === 'owner-a',
      ),
    ).toMatchObject({ state: 'success', workflow: { identity: 'review@1' } });
    expect(
      response.groups.find(
        (group) => group.workflow?.ownerBranchId === 'owner-b',
      ),
    ).toMatchObject({ state: 'scheduled', workflow: { identity: 'review@1' } });
    expect(parseDelegateHistoryResponse(response)).toEqual(response);

    const projected = projectDelegateHistoryEntry(branch[2], {
      sessionId: 'parent-1',
    }).entry as { data?: { kind?: string; state?: { attempts?: unknown[] } } };
    expect(projected.data?.kind).toBe('delta');
    expect(projected.data?.state?.attempts).toHaveLength(1);
  });

  it('fails closed on malformed durable workflow deltas', () => {
    const malformed = {
      type: 'custom',
      id: 'bad-workflow',
      customType: 'delegate-workflow:v1',
      data: {
        version: 1,
        kind: 'delta',
        state: { version: 1, attempts: [{ identity: 'incomplete' }] },
      },
    };
    const projected = projectDelegateHistoryEntry(malformed, {
      sessionId: 'parent-1',
    }).entry;
    expect(projected).not.toHaveProperty('data');
    expect(delegateHistoryFromBranch('parent-1', [malformed]).groups).toEqual(
      [],
    );
  });

  it('rejects noncanonical workflow identities and references before rendering', () => {
    const attempt = (overrides: Record<string, unknown> = {}) => ({
      logicalId: 'foo',
      attempt: 1,
      identity: 'foo@1',
      state: 'scheduled',
      dependencies: ['gate@1'],
      waitingFor: ['gate@1'],
      createdAt: 1,
      scheduledAt: 1,
      ...overrides,
    });
    const entry = (metadata: Record<string, unknown>) => ({
      type: 'custom',
      customType: 'delegate-workflow:v1',
      data: {
        version: 1,
        kind: 'snapshot',
        state: { version: 1, attempts: [metadata] },
      },
    });
    const malformed = [
      attempt({ logicalId: 'Foo', identity: 'Foo@1' }),
      attempt({ logicalId: 'foo\u0000bar', identity: 'foo\u0000bar@1' }),
      attempt({ identity: 'foo@2' }),
      attempt({ attempt: 0, identity: 'foo@0' }),
      attempt({ attempt: 1_000_000_000, identity: 'foo@1000000000' }),
      attempt({ dependencies: ['gate'] }),
      attempt({ dependencies: ['Gate@1'] }),
      attempt({ dependencies: ['gate@1', 'gate@1'] }),
      attempt({ waitingFor: ['other@1'] }),
      attempt({
        dependencies: Array.from(
          { length: 33 },
          (_, index) => `gate-${index}@1`,
        ),
        waitingFor: [],
      }),
    ];
    for (const metadata of malformed)
      expect(
        delegateHistoryFromBranch('parent-1', [entry(metadata)]).groups,
      ).toEqual([]);
  });

  it('folds wake replacement deltas without retaining raw payloads', () => {
    const baseWake = {
      id: 'review',
      state: 'pending',
      condition: { node: 'later@1' },
      references: ['later@1'],
      payload: [{ kind: 'handoff' }],
      createdAt: 1,
      revision: 1,
      dispatchGeneration: 0,
      dispatchAttempts: 0,
    };
    const enteredWake = {
      ...baseWake,
      state: 'entered',
      enteredAt: 4,
      revision: 2,
      dispatchGeneration: 1,
      dispatchAttempts: 1,
      handoff: 'secret delta handoff',
    };
    const branch = [
      {
        type: 'custom',
        id: 'wake-snapshot',
        customType: 'delegate-wake:v1',
        data: {
          version: 1,
          kind: 'snapshot',
          state: {
            version: 1,
            ownerSessionId: 'parent-1',
            ownerEpoch: 1,
            wakes: [baseWake],
          },
        },
      },
      {
        type: 'custom',
        id: 'wake-delta',
        customType: 'delegate-wake:v1',
        data: {
          version: 1,
          kind: 'delta',
          state: {
            version: 1,
            ownerSessionId: 'parent-1',
            ownerEpoch: 1,
            wakes: [enteredWake],
          },
        },
      },
    ];
    const response = delegateHistoryFromBranch('parent-1', branch);
    expect(response.groups).toHaveLength(1);
    expect(response.groups[0]).toMatchObject({
      lineageId: 'wake:review',
      state: 'success',
      wake: { id: 'review', state: 'entered', enteredAt: 4 },
    });
    expect(JSON.stringify(response)).not.toContain('secret delta handoff');
    const projected = projectDelegateHistoryEntry(branch[1], {
      sessionId: 'parent-1',
    }).entry;
    expect(projected).toMatchObject({
      customType: 'delegate-wake:v1',
      data: { kind: 'delta' },
    });
    expect(JSON.stringify(projected)).not.toContain('payload');
  });

  it('projects entered wake metadata from existing wake entries after reload', () => {
    const entry = {
      type: 'custom',
      id: 'wake-entry-1',
      customType: 'delegate-wake:v1',
      data: {
        version: 1,
        kind: 'snapshot',
        state: {
          version: 1,
          ownerSessionId: 'parent-1',
          ownerEpoch: 1,
          wakes: [
            {
              id: 'review',
              state: 'entered',
              condition: { node: 'later@1' },
              references: ['later@1'],
              payload: [{ kind: 'handoff' }],
              createdAt: 1,
              enteredAt: 4,
              revision: 2,
              dispatchGeneration: 1,
              dispatchAttempts: 1,
              handoff: 'secret wake handoff',
            },
          ],
        },
      },
    };
    const response = delegateHistoryFromBranch('parent-1', [entry]);
    expect(response.groups[0]).toMatchObject({
      lineageId: 'wake:review',
      state: 'success',
      wake: { id: 'review', state: 'entered', enteredAt: 4 },
    });
    expect(JSON.stringify(response)).not.toContain('secret wake handoff');
    expect(
      JSON.stringify(
        projectDelegateHistoryEntry(entry, { sessionId: 'parent-1' }).entry,
      ),
    ).not.toContain('payload');
  });
});
