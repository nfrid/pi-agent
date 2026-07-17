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
