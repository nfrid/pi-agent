import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateSessions,
  compareSummaries,
  parseSessionJsonl,
  summarizePaths,
} from './index.mjs';

const temporaryDirectories = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

function line(value) {
  return JSON.stringify(value);
}

function fixture({ todoCalls = 1, input = 10, cacheRead = 30 } = {}) {
  return [
    line({
      type: 'session',
      id: 'header',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/private/repo',
    }),
    line({
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: 'SECRET PROMPT' },
    }),
    line({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: Array.from({ length: todoCalls }, (_, index) => ({
          type: 'toolCall',
          name: 'todo',
          arguments: { content: `PRIVATE TODO ${index}` },
        })),
        usage: { input, output: 4, cacheRead, cacheWrite: 5 },
      },
    }),
    line({
      type: 'message',
      id: 'abandoned',
      parentId: 'a1',
      timestamp: '2026-01-01T00:00:03.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            name: 'todo',
            arguments: { content: 'ABANDONED SECRET' },
          },
        ],
        usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 },
      },
    }),
    line({
      type: 'message',
      id: 'tr1',
      parentId: 'a1',
      timestamp: '2026-01-01T00:00:04.000Z',
      message: {
        role: 'toolResult',
        toolName: 'todo',
        content: 'PRIVATE RESULT',
      },
    }),
    line({
      type: 'compaction',
      id: 'c1',
      parentId: 'tr1',
      timestamp: '2026-01-01T00:00:05.000Z',
      summary: 'PRIVATE SUMMARY',
    }),
    line({
      type: 'message',
      id: 'u2',
      parentId: 'c1',
      timestamp: '2026-01-01T00:00:06.000Z',
      message: { role: 'user', content: 'ANOTHER SECRET' },
    }),
  ].join('\n');
}

/**
 * A session of delegate exchanges: each entry is one assistant call and the
 * tool result it produced, chained so every one stays on the active ancestry.
 */
function delegateFixture(exchanges) {
  const lines = [
    line({
      type: 'session',
      id: 'header',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/private/repo',
    }),
  ];
  let parentId = null;
  exchanges.forEach((exchange, index) => {
    // A pushed background completion is not a call and has no result to pair.
    if (exchange.customType) {
      const id = `c${index}`;
      lines.push(
        line({
          type: 'custom_message',
          customType: exchange.customType,
          content: exchange.content,
          details: exchange.details,
          id,
          parentId,
          timestamp: `2026-01-01T00:03:${String(index).padStart(2, '0')}.000Z`,
        }),
      );
      parentId = id;
      return;
    }
    const callId = `a${index}`;
    const resultId = `r${index}`;
    lines.push(
      line({
        type: 'message',
        id: callId,
        parentId,
        timestamp: `2026-01-01T00:01:${String(index).padStart(2, '0')}.000Z`,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: `delegate-${index}`,
              name: 'delegate',
              arguments: exchange.arguments ?? { task: 'PRIVATE TASK' },
            },
          ],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      }),
    );
    lines.push(
      line({
        type: 'message',
        id: resultId,
        parentId: callId,
        timestamp: `2026-01-01T00:02:${String(index).padStart(2, '0')}.000Z`,
        message: {
          role: 'toolResult',
          toolCallId: exchange.toolCallId ?? `delegate-${index}`,
          toolName: exchange.toolName ?? 'delegate',
          content: [{ type: 'text', text: exchange.text ?? 'HANDOFF' }],
          details: exchange.details,
          isError: exchange.isError ?? false,
        },
      }),
    );
    parentId = resultId;
  });
  return lines.join('\n');
}

const singleRun = { mode: 'single', runs: [{ allowWrites: false }] };

describe('parseSessionJsonl', () => {
  it('measures only the active leaf ancestry and request usage', () => {
    const result = parseSessionJsonl(fixture());
    expect(result).toMatchObject({
      userTurns: 2,
      assistantTurns: 1,
      todoToolCalls: 1,
      todoToolResults: 1,
      compactions: 1,
      elapsedMs: 5000,
      usageInput: 10,
      usageOutput: 4,
      usageCacheRead: 30,
      usageCacheWrite: 5,
      peakRequestContext: 45,
      cacheHitRatio: 30 / 45,
      malformedLines: 0,
    });
    expect(result.sessionId).toMatch(/^[a-f0-9]{12}$/);
  });

  it('skips malformed lines without leaking content into aggregates', () => {
    const source = `${fixture()}\n{PRIVATE MALFORMED CONTENT`;
    const serialized = JSON.stringify(parseSessionJsonl(source));
    expect(JSON.parse(serialized).malformedLines).toBe(1);
    for (const secret of [
      'SECRET',
      'PRIVATE',
      '/private/repo',
      'PROMPT',
      'RESULT',
      'SUMMARY',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('delegate measurements', () => {
  it('counts tasks, parent-visible bytes, and task shape from the runs that ran', () => {
    const result = parseSessionJsonl(
      delegateFixture([
        { text: 'ab', details: singleRun },
        {
          text: 'cdef',
          details: {
            mode: 'parallel',
            runs: [{ allowWrites: true }, { allowWrites: false }],
          },
        },
      ]),
    );
    expect(result).toMatchObject({
      delegateToolCalls: 2,
      delegatedTasks: 3,
      delegateParallelCalls: 1,
      delegateWritableTasks: 1,
      delegateHandoffBytes: 6,
      delegateRejectedCalls: 0,
      delegateHandoffBytesPerTask: 2,
    });
  });

  it('measures handoff bytes in UTF-8, not characters', () => {
    const result = parseSessionJsonl(
      delegateFixture([{ text: 'é', details: singleRun }]),
    );
    expect(result.delegateHandoffBytes).toBe(2);
  });

  it('excludes rejected calls from tasks and bytes', () => {
    const result = parseSessionJsonl(
      delegateFixture([
        { text: 'ab', details: singleRun },
        // A call rejected for invalid parameters: a delegate result with no runs.
        {
          text: 'A continuation reuses its route.',
          details: {},
          isError: true,
        },
      ]),
    );
    expect(result).toMatchObject({
      delegateToolCalls: 2,
      delegateRejectedCalls: 1,
      delegatedTasks: 1,
      delegateHandoffBytes: 2,
      delegateHandoffBytesPerTask: 2,
    });
  });

  it('counts current truncated-report markers, capped at the runs present', () => {
    const twoRuns = {
      mode: 'parallel',
      runs: [{ allowWrites: false }, { allowWrites: false }],
    };
    expect(
      parseSessionJsonl(
        delegateFixture([
          {
            text: 'Outcome: partial\nTruncation: original report truncated\nTruncation: none',
            details: twoRuns,
          },
        ]),
      ),
    ).toMatchObject({
      delegateTruncatedTasks: 1,
      delegateTruncationRate: 0.5,
      delegateOutcomePartial: 1,
    });

    expect(
      parseSessionJsonl(
        delegateFixture([
          {
            // Historical reports retain the former marker without changing
            // current-report accounting.
            text: 'Truncation: body truncated\nTruncation: body truncated\nTruncation: body truncated',
            details: twoRuns,
          },
        ]),
      ).delegateTruncatedTasks,
    ).toBe(2);
  });

  it('falls back to the legacy inline marker when no envelope flag is present', () => {
    expect(
      parseSessionJsonl(
        delegateFixture([
          {
            text: 'findings\n\n[Output truncated for parent context; full output is preserved in tool details.]',
            details: singleRun,
          },
        ]),
      ).delegateTruncatedTasks,
    ).toBe(1);
  });

  it('charges background work to its complete delivery rather than to its acknowledgement', () => {
    const handoff =
      'Delegated results: 1 run\n\nStatus: success\nOutcome: done\nTruncation: none';
    const delivered = `Background delegate job dj-1 (audit) success\n\n${handoff}`;
    const result = parseSessionJsonl(
      delegateFixture([
        {
          text: 'Started 1 background delegate job: dj-1. Each subagent completion will be delivered automatically.\ndj-1 continuation: token',
          details: singleRun,
        },
        {
          toolName: 'delegate_jobs',
          text: delivered,
          details: {
            action: 'peek',
            job: { id: 'dj-1', state: 'success', handoff, runs: [{}] },
          },
        },
      ]),
    );
    expect(result).toMatchObject({
      delegateBackgroundJobsLaunched: 1,
      delegateBackgroundRunsLaunched: 1,
      delegateBackgroundDeliveries: 1,
      delegatedTasks: 1,
      delegateOutcomeDone: 1,
      // The parent receives the complete tool result, including its job label.
      delegateHandoffBytes: Buffer.byteLength(delivered, 'utf8'),
    });
  });

  it('uses snapshot runs instead of reconstructing parallel work from text', () => {
    const handoff =
      'Delegated results: 3 runs\n\nOutcome: partial\nTruncation: original report truncated';
    expect(
      parseSessionJsonl(
        delegateFixture([
          {
            toolName: 'delegate_jobs',
            text: `Background delegate job dj-2 (fan) success\n\n${handoff}`,
            details: {
              action: 'peek',
              job: {
                id: 'dj-2',
                state: 'success',
                handoff,
                runs: [
                  {
                    routing: { route: 'quick', relativeCost: 1 },
                    usage: { turns: 3 },
                  },
                  {},
                  {},
                ],
              },
            },
          },
        ]),
      ),
    ).toMatchObject({
      delegatedTasks: 3,
      delegateTruncatedTasks: 1,
      delegateOutcomePartial: 1,
      routedTasks: 1,
      childTurns: 3,
    });
  });

  it('counts an automatic parallel delivery from details.jobs without splitting its text', () => {
    const first =
      'Delegated results: 1 run\n\nOutcome: done\n\n---\n\n### Task 2 output\nEvidence retained\nTruncation: none';
    const second =
      'Delegated results: 1 run\n\nOutcome: partial\nTruncation: none';
    // This is the real automatic producer shape. The parallel handoff and the
    // automatic batch both use this delimiter, so it is not a protocol boundary.
    const delivered = [
      `# Background delegate job dj-1 (audit) success\n\n${first}`,
      `# Background delegate job dj-2 (fan) success\n\n${second}`,
    ].join('\n\n---\n\n');
    const result = parseSessionJsonl(
      delegateFixture([
        {
          text: 'Started 2 background delegate jobs: dj-1, dj-2.',
          details: { mode: 'parallel', runs: [{}, {}] },
        },
        {
          customType: 'delegate-job-result',
          content: delivered,
          details: {
            jobs: [
              { id: 'dj-1', state: 'success', handoff: first, runs: [{}] },
              { id: 'dj-2', state: 'success', handoff: second, runs: [{}] },
            ],
          },
        },
      ]),
    );
    expect(result).toMatchObject({
      delegateBackgroundJobsLaunched: 2,
      delegateBackgroundRunsLaunched: 2,
      delegateBackgroundDeliveries: 2,
      delegatedTasks: 2,
      delegateOutcomeDone: 1,
      delegateOutcomePartial: 1,
      delegateHandoffBytes: Buffer.byteLength(delivered, 'utf8'),
    });
  });

  it('deduplicates push and peek executions while retaining every delivered byte', () => {
    const handoff =
      'Delegated results: 1 run\n\nOutcome: failed\nTruncation: original report truncated';
    const job = {
      id: 'dj-1',
      state: 'error',
      handoff,
      runs: [
        {
          state: 'error',
          routing: { route: 'quick', relativeCost: 1 },
          usage: { turns: 2 },
        },
      ],
    };
    const pushed = `# Background delegate job dj-1 (audit) error\n\n${handoff}`;
    const peeked = `Background delegate job dj-1 (audit) error\n\n${handoff}`;
    const result = parseSessionJsonl(
      delegateFixture([
        {
          arguments: {
            task: 'PRIVATE',
            continuation: 'wip-token',
            refresh: 'wip',
          },
          text: 'Started 1 background delegate job: dj-1.',
          details: { runs: [{ backgroundJobId: 'dj-1' }] },
        },
        {
          customType: 'delegate-job-result',
          content: pushed,
          details: { jobs: [job] },
        },
        {
          toolName: 'delegate_jobs',
          text: peeked,
          details: { action: 'peek', job },
        },
      ]),
    );
    expect(result).toMatchObject({
      delegatedTasks: 1,
      delegateBackgroundDeliveries: 2,
      delegateBackgroundAutomaticDeliveries: 1,
      delegateBackgroundPeekDeliveries: 1,
      delegateBackgroundDeliveryOverlaps: 1,
      delegateHandoffBytes:
        Buffer.byteLength(pushed, 'utf8') + Buffer.byteLength(peeked, 'utf8'),
      delegateTruncatedTasks: 1,
      delegateOutcomeFailed: 1,
      delegateProcessErrors: 1,
      routedTasks: 1,
      childTurns: 2,
      delegateWipRefreshAttempts: 1,
      delegateWipRefreshFailures: 1,
      delegateWipPackageReviewAttempts: 1,
      delegateWipPackageReviewFailedDependencyProjections: 1,
    });
  });

  it('does not count automatic-queued guidance as a peek delivery or overlap', () => {
    const handoff = 'Delegated results: 1 run\n\nOutcome: done';
    const job = { id: 'dj-queued', state: 'success', handoff, runs: [{}] };
    const result = parseSessionJsonl(
      delegateFixture([
        {
          text: 'Started 1 background delegate job: dj-queued.',
          details: { runs: [{ backgroundJobId: 'dj-queued' }] },
        },
        {
          toolName: 'delegate_jobs',
          text: 'Automatic result for dj-queued is already queued and will enter context shortly.',
          details: {
            action: 'peek',
            delivery: 'automatic-queued',
            job,
          },
        },
        {
          customType: 'delegate-job-result',
          content: `# Background delegate job dj-queued (audit) success\n\n${handoff}`,
          details: { jobs: [job] },
        },
      ]),
    );
    expect(result).toMatchObject({
      delegateBackgroundDeliveries: 1,
      delegateBackgroundAutomaticDeliveries: 1,
      delegateBackgroundPeekDeliveries: 0,
      delegateBackgroundDeliveryOverlaps: 0,
    });
  });

  it('counts strict unknown-tool-argument blocks without emitting names', () => {
    const serialized = JSON.stringify(
      parseSessionJsonl(
        delegateFixture([
          {
            toolName: 'bash',
            text: 'Tool "bash" does not support argument "workdir". Remove it and retry.',
            details: {},
            isError: true,
          },
          {
            toolName: 'bash',
            text: 'Tool "bash" does not support argument "workdir". Remove it and retry.',
            details: {},
            isError: false,
          },
          {
            toolName: 'bash',
            text: 'Tool "bash" arguments do not match its declared schema.',
            details: {},
            isError: true,
          },
        ]),
      ),
    );
    expect(JSON.parse(serialized).unknownToolArgumentBlocks).toBe(1);
    expect(serialized).not.toContain('bash');
    expect(serialized).not.toContain('workdir');
  });

  it('recognizes current and historical background reports without details', () => {
    const current =
      '# Background delegate job dj-current (audit) success\n\nDelegated results: 1 run\n\nOutcome: done\nTruncation: original report truncated';
    const historical =
      '# Background delegate job dj-old (audit) success\n\nDelegated task succeeded\n\nOutcome: partial\nTruncation: body truncated';
    const result = parseSessionJsonl(
      delegateFixture([
        { customType: 'delegate-job-result', content: current },
        { customType: 'delegate-job-result', content: historical },
      ]),
    );
    expect(result).toMatchObject({
      delegateBackgroundDeliveries: 2,
      delegatedTasks: 2,
      delegateTruncatedTasks: 2,
      delegateOutcomeDone: 1,
      delegateOutcomePartial: 1,
      delegateHandoffBytes:
        Buffer.byteLength(current, 'utf8') +
        Buffer.byteLength(historical, 'utf8'),
    });
  });

  it('ignores delegate_jobs results that carry no delivered handoff', () => {
    expect(
      parseSessionJsonl(
        delegateFixture([
          {
            toolName: 'delegate_jobs',
            text: 'dj-1 running — audit\nCompletion will be delivered automatically.',
            details: { action: 'peek' },
          },
        ]),
      ),
    ).toMatchObject({ delegateBackgroundDeliveries: 0, delegatedTasks: 0 });
  });

  it('counts a completed cancel handoff but not a cancelled job without one', () => {
    const completedHandoff =
      'Delegated results: 1 run\n\nOutcome: done\nTruncation: none';
    const cancelled =
      'Background delegate job dj-cancelled (slow audit) cancelled\nCompletion will be delivered automatically.';
    const text = [
      `Background delegate job dj-completed (audit) success\n\n${completedHandoff}`,
      cancelled,
    ].join('\n\n');
    const result = parseSessionJsonl(
      delegateFixture([
        {
          text: 'Started 2 background delegate jobs: dj-completed, dj-cancelled.',
          details: { mode: 'parallel', runs: [{}, {}] },
        },
        {
          toolName: 'delegate_jobs',
          text,
          details: {
            action: 'cancel',
            jobs: [
              {
                id: 'dj-completed',
                state: 'success',
                handoff: completedHandoff,
                runs: [
                  {
                    routing: { route: 'quick', relativeCost: 1 },
                    usage: { turns: 2 },
                  },
                ],
              },
              { id: 'dj-cancelled', state: 'cancelled', runs: [{}] },
            ],
          },
        },
      ]),
    );
    expect(result).toMatchObject({
      delegateBackgroundDeliveries: 1,
      // Both jobs were launched; only the completed one is delivered by cancel.
      delegatedTasks: 2,
      delegateOutcomeDone: 1,
      routedTasks: 1,
      childTurns: 2,
      delegateHandoffBytes: Buffer.byteLength(text, 'utf8'),
    });
  });

  it('charges what a child spent to the route that ran it', () => {
    const run = (route, relativeCost, usage) => ({
      routing: { route, relativeCost },
      usage,
    });
    const result = parseSessionJsonl(
      delegateFixture([
        {
          details: {
            mode: 'parallel',
            runs: [
              run('luna-low', 1, {
                input: 100,
                output: 10,
                turns: 2,
                cost: 0.5,
              }),
              run('terra-high', 8, {
                input: 900,
                output: 90,
                turns: 8,
                cost: 4,
              }),
            ],
          },
        },
        {
          details: {
            runs: [
              run('luna-low', 1, {
                input: 50,
                output: 5,
                turns: 1,
                cost: 0.25,
              }),
            ],
          },
        },
      ]),
    );
    expect(result.routes).toEqual({
      'luna-low': {
        tasks: 2,
        turns: 3,
        usageInput: 150,
        usageOutput: 15,
        cost: 0.75,
        relativeCost: 1,
      },
      'terra-high': {
        tasks: 1,
        turns: 8,
        usageInput: 900,
        usageOutput: 90,
        cost: 4,
        relativeCost: 8,
      },
    });
    expect(result).toMatchObject({ childTurns: 11, childCost: 4.75 });
  });

  it('bills a background job to its route once however often it is reported', () => {
    const job = {
      id: 'dj-1',
      state: 'success',
      handoff: 'Delegated results: 1 run\n\nStatus: success',
      runs: [
        {
          routing: { route: 'terra-max', relativeCost: 13 },
          usage: { turns: 9 },
        },
      ],
    };
    const result = parseSessionJsonl(
      delegateFixture([
        {
          text: 'Started 1 background delegate job: dj-1.',
          // The acknowledgement's run has not spent anything yet.
          details: {
            runs: [
              { routing: { route: 'terra-max', relativeCost: 13 }, usage: {} },
            ],
          },
        },
        {
          customType: 'delegate-job-result',
          content:
            '# Background delegate job dj-1 (audit) success\n\nDelegated results: 1 run\n\nStatus: success',
          details: { jobs: [job] },
        },
        {
          toolName: 'delegate_jobs',
          text: 'Background delegate job dj-1 (audit) success\n\nDelegated results: 1 run\n\nStatus: success',
          details: { action: 'peek', job },
        },
      ]),
    );
    // Delivered and then peeked at: two handoffs the parent paid context for,
    // but only one child run to bill.
    expect(result.delegateBackgroundDeliveries).toBe(2);
    expect(result.routes['terra-max'].tasks).toBe(1);
    expect(result.childTurns).toBe(9);
  });

  it('counts parallel continuations as calls, including arguments left as JSON text', () => {
    const parallel = parseSessionJsonl(
      delegateFixture([
        { details: singleRun },
        {
          arguments: {
            tasks: [
              { continuation: 'one', task: 'PRIVATE' },
              { continuation: 'two', task: 'PRIVATE' },
            ],
          },
          details: { mode: 'parallel', runs: [{}, {}] },
        },
      ]),
    );
    expect(parallel).toMatchObject({
      delegateContinuationCalls: 1,
      delegateContinuationRate: 1 / 2,
    });

    const result = parseSessionJsonl(
      delegateFixture([
        { arguments: { task: 'PRIVATE TASK' }, details: singleRun },
        {
          arguments: { continuation: 'token', task: 'PRIVATE' },
          details: singleRun,
        },
        {
          arguments: JSON.stringify({ continuation: 'token', task: 'PRIVATE' }),
          details: singleRun,
        },
      ]),
    );
    expect(result).toMatchObject({
      delegateToolCalls: 3,
      delegateContinuationCalls: 2,
      delegateContinuationRate: 2 / 3,
    });
  });

  it('counts outcomes and return indicators once per execution', () => {
    const result = parseSessionJsonl(
      delegateFixture([
        {
          text: 'Outcome: partial\nArtifact: art_safe\nExact output artifact unavailable',
          details: {
            runs: [
              {
                state: 'timed-out',
                artifact: { handle: 'art_safe' },
                worktree: { branch: 'delegate/task' },
              },
            ],
          },
        },
      ]),
    );
    expect(result).toMatchObject({
      delegateOutcomePartial: 1,
      delegateProcessTimeouts: 1,
      delegateArtifactReferences: 1,
      delegateArtifactFallbacks: 1,
      delegateWorktreeReturns: 1,
    });
  });

  it('measures clean snapshot retirement, continuations, and refresh outcomes by stable IDs', () => {
    const snapshot = (base, links = 0) => ({
      status: 'finished',
      snapshot: true,
      snapshotBase: base,
      hasWork: false,
      carriedFileCount: 0,
      dependencyProjectionCandidateCount: links,
      dependencyLinkCount: links,
    });
    const success = (worktree) => ({
      allowWrites: false,
      state: 'success',
      exitCode: 0,
      worktree,
    });
    const failed = { allowWrites: false, state: 'error', exitCode: 1 };
    const result = parseSessionJsonl(
      delegateFixture([
        { details: { runs: [success(snapshot('head'))] } },
        {
          arguments: { task: 'PRIVATE', continuation: 'same-token' },
          details: { runs: [success(snapshot('head'))] },
        },
        {
          arguments: {
            task: 'PRIVATE',
            continuation: 'wip-token',
            refresh: 'wip',
          },
          details: { runs: [success(snapshot('wip', 2))] },
        },
        {
          arguments: {
            task: 'PRIVATE',
            continuation: 'head-token',
            refresh: 'head',
          },
          details: { runs: [failed] },
        },
        {
          arguments: {
            task: 'PRIVATE',
            continuation: 'wip-preflight',
            refresh: 'wip',
          },
          details: {},
          isError: true,
        },
        {
          arguments: {
            task: 'PRIVATE',
            continuation: 'wip-zero',
            refresh: 'wip',
          },
          details: { runs: [success(snapshot('wip'))] },
        },
        {
          arguments: {
            task: 'PRIVATE',
            continuation: 'wip-failed',
            refresh: 'wip',
          },
          details: { runs: [failed] },
        },
      ]),
    );
    expect(result).toMatchObject({
      delegateCleanReadOnlySnapshotRetirements: 4,
      delegateSameSnapshotContinuations: 1,
      delegateWipRefreshAttempts: 4,
      delegateWipRefreshSuccesses: 2,
      delegateWipRefreshFailures: 2,
      delegateHeadRefreshAttempts: 1,
      delegateHeadRefreshSuccesses: 0,
      delegateHeadRefreshFailures: 1,
      delegateWipPackageReviewAttempts: 4,
      delegateWipPackageReviewSuccessfulNonzeroDependencyProjections: 1,
      delegateWipPackageReviewZeroLinkProjections: 1,
      delegateWipPackageReviewFailedDependencyProjections: 2,
    });
  });

  it('requires a matching tool-call ID and excludes legacy, writable, changed, and failed runs', () => {
    const lifecycleMetadata = {
      status: 'finished',
      snapshotBase: 'head',
      carriedFileCount: 0,
      dependencyProjectionCandidateCount: 0,
      dependencyLinkCount: 0,
    };
    const result = parseSessionJsonl(
      delegateFixture([
        {
          arguments: { task: 'PRIVATE', continuation: 'token', refresh: 'wip' },
          toolCallId: 'another-call',
          details: {
            runs: [
              {
                allowWrites: false,
                state: 'success',
                exitCode: 0,
                worktree: { snapshot: true },
              },
            ],
          },
        },
        {
          details: {
            runs: [
              {
                allowWrites: true,
                state: 'success',
                exitCode: 0,
                worktree: {
                  ...lifecycleMetadata,
                  snapshot: true,
                  hasWork: false,
                },
              },
            ],
          },
        },
        {
          details: {
            runs: [
              {
                allowWrites: false,
                state: 'success',
                exitCode: 0,
                worktree: { ...lifecycleMetadata, hasWork: true },
              },
            ],
          },
        },
        {
          details: {
            runs: [
              {
                allowWrites: false,
                state: 'error',
                exitCode: 1,
                worktree: {
                  ...lifecycleMetadata,
                  snapshot: true,
                  hasWork: false,
                },
              },
            ],
          },
        },
      ]),
    );
    expect(result).toMatchObject({
      delegateCleanReadOnlySnapshotRetirements: 0,
      delegateWipRefreshAttempts: 0,
      delegateWipPackageReviewAttempts: 0,
    });
  });

  it('counts a recovered continuation as its current successful execution', () => {
    const result = parseSessionJsonl(
      delegateFixture([
        {
          text: 'Outcome: partial',
          details: {
            runs: [{ state: 'timed-out', exitCode: 124, allowWrites: true }],
          },
        },
        {
          arguments: { task: 'PRIVATE TASK', continuation: 'token' },
          text: 'Outcome: done\nNote: Earlier attempt timed out; this continuation completed on the same branch.',
          details: {
            runs: [{ state: 'success', exitCode: 0, allowWrites: true }],
          },
        },
      ]),
    );

    expect(result).toMatchObject({
      delegateToolCalls: 2,
      delegateContinuationCalls: 1,
      delegatedTasks: 2,
      delegateProcessTimeouts: 1,
      delegateProcessErrors: 0,
      delegateOutcomePartial: 1,
      delegateOutcomeDone: 1,
    });
  });

  it('counts background launches and executions once while charging repeated reports', () => {
    const job = {
      id: 'dj-1',
      state: 'error',
      handoff: 'Delegated results: 1 run\n\nOutcome: failed',
      runs: [
        {
          allowWrites: true,
          state: 'error',
          routing: { route: 'quick', relativeCost: 1 },
          usage: { turns: 2, cost: 3 },
        },
      ],
    };
    const result = parseSessionJsonl(
      delegateFixture([
        {
          text: 'Started 1 background delegate job: dj-1.',
          details: { mode: 'parallel', runs: [{ allowWrites: true }] },
        },
        {
          customType: 'delegate-job-result',
          content:
            '# Background delegate job dj-1 (audit) error\n\nDelegated results: 1 run\n\nOutcome: failed',
          details: { jobs: [job] },
        },
        {
          toolName: 'delegate_jobs',
          text: '# Background delegate job dj-1 (audit) error\n\nDelegated results: 1 run\n\nOutcome: failed',
          details: { action: 'peek', job },
        },
      ]),
    );
    expect(result).toMatchObject({
      delegateBackgroundJobsLaunched: 1,
      delegateBackgroundRunsLaunched: 1,
      delegateBackgroundDeliveries: 2,
      delegateParallelCalls: 1,
      delegatedTasks: 1,
      delegateWritableTasks: 1,
      delegateOutcomeFailed: 1,
      delegateProcessErrors: 1,
      routedTasks: 1,
      childTurns: 2,
      childCost: 3,
    });
  });

  it('excludes legacy unrouted tasks from child spend per-task ratios', () => {
    const result = parseSessionJsonl(
      delegateFixture([
        {
          details: {
            runs: [
              {
                routing: { route: 'quick', relativeCost: 1 },
                usage: { turns: 4, cost: 2 },
              },
            ],
          },
        },
        { details: { runs: [{}] } },
      ]),
    );
    expect(result).toMatchObject({
      delegatedTasks: 2,
      routedTasks: 1,
      childTurnsPerTask: 4,
      childCostPerTask: 2,
    });
  });

  it('keeps delegated task text and handoff bodies out of the output', () => {
    const result = parseSessionJsonl(
      delegateFixture([
        { arguments: { task: 'PRIVATE TASK' }, details: singleRun },
        {
          arguments: { continuation: 'token', task: 'PRIVATE' },
          details: singleRun,
        },
        {
          arguments: JSON.stringify({ continuation: 'token', task: 'PRIVATE' }),
          details: singleRun,
        },
      ]),
    );
    expect(result).toMatchObject({
      delegateToolCalls: 3,
      delegateContinuationCalls: 2,
      delegateContinuationRate: 2 / 3,
    });
  });

  it('keeps delegated task text and handoff bodies out of the output', () => {
    const serialized = JSON.stringify(
      parseSessionJsonl(
        delegateFixture([
          {
            arguments: {
              task: 'PRIVATE TASK',
              contextNote: 'SECRET CONTEXT',
              scope: ['/private/repo/src'],
            },
            text: 'PRIVATE HANDOFF BODY',
            details: { mode: 'single', runs: [{ task: 'PRIVATE TASK' }] },
          },
        ]),
      ),
    );
    for (const secret of ['PRIVATE', 'SECRET', '/private/repo'])
      expect(serialized).not.toContain(secret);
  });
});

describe('cohorts', () => {
  it('aggregates source-specific background delivery counts and overlaps', () => {
    const handoff = 'Delegated results: 1 run\n\nOutcome: done';
    const job = {
      id: 'dj-cohort',
      state: 'success',
      handoff,
      runs: [{}],
    };
    const session = parseSessionJsonl(
      delegateFixture([
        {
          text: 'Started 1 background delegate job: dj-cohort.',
          details: { runs: [{ backgroundJobId: 'dj-cohort' }] },
        },
        {
          customType: 'delegate-job-result',
          content: `# Background delegate job dj-cohort (audit) success\n\n${handoff}`,
          details: { jobs: [job] },
        },
        {
          toolName: 'delegate_jobs',
          text: `Background delegate job dj-cohort (audit) success\n\n${handoff}`,
          details: { action: 'peek', job },
        },
      ]),
    );
    const cohort = aggregateSessions([session]);
    expect(cohort.totals).toMatchObject({
      delegateBackgroundAutomaticDeliveries: 1,
      delegateBackgroundPeekDeliveries: 1,
      delegateBackgroundDeliveryOverlaps: 1,
    });
    expect(cohort.medians.delegateBackgroundDeliveryOverlaps).toBe(1);
  });

  it('discovers directories and applies todo and limit filters', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-metrics-'));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(join(directory, 'one.jsonl'), fixture({ todoCalls: 1 })),
      writeFile(join(directory, 'two.jsonl'), fixture({ todoCalls: 2 })),
      writeFile(join(directory, 'ignored.txt'), 'PRIVATE FILE CONTENT'),
    ]);
    const result = await summarizePaths([directory], {
      minTodoCalls: 1,
      limit: 1,
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.cohort.sessionCount).toBe(1);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(directory);
    expect(serialized).not.toContain('one.jsonl');
    expect(serialized).not.toContain('PRIVATE');

    const filtered = await summarizePaths([directory], { minTodoCalls: 2 });
    expect(filtered.sessions).toHaveLength(1);
    expect(filtered.sessions[0].todoToolCalls).toBe(2);
  });

  it('filters on delegate calls and weights cohort ratios by totals', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-metrics-'));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(join(directory, 'none.jsonl'), fixture()),
      writeFile(
        join(directory, 'cheap.jsonl'),
        delegateFixture([{ text: 'ab', details: singleRun }]),
      ),
      writeFile(
        join(directory, 'costly.jsonl'),
        delegateFixture([
          {
            text: 'x'.repeat(30),
            details: {
              mode: 'parallel',
              runs: [{ allowWrites: true }, { allowWrites: true }],
            },
          },
        ]),
      ),
    ]);
    const result = await summarizePaths([directory], { minDelegateCalls: 1 });
    expect(result.cohort.sessionCount).toBe(2);
    // 32 bytes over 3 tasks, not the mean of 2 and 15.
    expect(result.cohort.totals.delegateHandoffBytesPerTask).toBeCloseTo(
      32 / 3,
    );
    expect(result.cohort.medians.delegateHandoffBytesPerTask).toBe(8.5);
    expect(result.cohort.totals.delegateWritableTasks).toBe(2);
  });

  it('computes weighted totals, medians, and comparison deltas', () => {
    const baselineSessions = [
      parseSessionJsonl(fixture({ input: 10, cacheRead: 30 })),
      parseSessionJsonl(fixture({ input: 30, cacheRead: 10 })),
    ];
    const comparisonSessions = [
      parseSessionJsonl(fixture({ input: 10, cacheRead: 90 })),
      parseSessionJsonl(fixture({ input: 10, cacheRead: 10 })),
    ];
    const comparison = compareSummaries(
      { cohort: aggregateSessions(baselineSessions) },
      { cohort: aggregateSessions(comparisonSessions) },
    );
    expect(comparison.baseline.totals.cacheHitRatio).toBeCloseTo(40 / 90);
    expect(comparison.comparison.totals.cacheHitRatio).toBeCloseTo(100 / 130);
    expect(comparison.baseline.medians.usageInput).toBe(20);
    expect(comparison.comparison.medians.usageInput).toBe(10);
    expect(comparison.deltas.medians.usageInput).toBe(-10);
    expect(comparison.deltas.totals.cacheHitRatio).toBeCloseTo(
      100 / 130 - 40 / 90,
    );
  });
});
