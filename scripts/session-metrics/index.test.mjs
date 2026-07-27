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
          toolName: 'delegate',
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

  it('counts truncated tasks from the envelope marker, capped at the runs present', () => {
    const twoRuns = {
      mode: 'parallel',
      runs: [{ allowWrites: false }, { allowWrites: false }],
    };
    expect(
      parseSessionJsonl(
        delegateFixture([
          {
            text: 'Truncation: body truncated\nTruncation: none',
            details: twoRuns,
          },
        ]),
      ),
    ).toMatchObject({ delegateTruncatedTasks: 1, delegateTruncationRate: 0.5 });

    expect(
      parseSessionJsonl(
        delegateFixture([
          {
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

  it('counts continuations, including arguments left as JSON text', () => {
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
