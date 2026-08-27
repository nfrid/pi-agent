import { describe, expect, test, vi } from 'vitest';
import {
  buildParentHandoff,
  PARENT_HANDOFF_CAPS,
  truncateBytes,
} from './output';
import { buildOutputFileHandoff } from './tool-result';
import { createRun } from './types';

const assistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
  usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
};

function reportedRun(
  report: string,
  metadata: Parameters<typeof createRun>[2] = {},
) {
  const run = createRun('review the implementation', undefined, metadata);
  run.exitCode = 0;
  run.state = 'success';
  run.messages = [
    {
      ...assistantMessage,
      content: [{ type: 'text', text: report }],
    } as never,
  ];
  return run;
}

describe('output', () => {
  test('truncates by UTF-8 bytes', () => {
    const output = truncateBytes('🙂'.repeat(100), 100);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(100);
    expect(output).toContain('Output truncated');
  });

  test('keeps a blocker and continuation when an inline fallback cannot fit', () => {
    const run = reportedRun(
      [
        'Outcome: blocked',
        'Conclusion: implementation needs a parent decision',
        'Blocked: should a 429 retry despite the stated never-retry rule?',
        'Evidence: src/retry.ts:42 is the conflicting branch',
        'x'.repeat(20_000),
      ].join('\n\n'),
      { continuation: 'continue-blocked-child' },
    );
    const handoff = buildParentHandoff([run], {
      ...PARENT_HANDOFF_CAPS,
      singleMaxBytes: 1,
    });

    expect(handoff).toContain(
      'Blocked: should a 429 retry despite the stated never-retry rule?',
    );
    expect(handoff).toContain(
      'Continuation available in the retained child context.',
    );
    expect(handoff).not.toContain('continue-blocked-child');
    expect(handoff).toContain('Mandatory delegate metadata exceeds');
    expect(handoff).not.toContain('Outcome: blocked');
    expect(handoff).not.toContain(
      'Conclusion: implementation needs a parent decision',
    );
  });

  test('keeps task identity in a maximum-width parallel fan when reports cannot fit', () => {
    const runs = Array.from({ length: 20 }, (_, index) =>
      reportedRun(
        `Outcome: partial\nConclusion: conclusion ${index + 1}\nEvidence: src/${index}.ts:1\n\n${'details '.repeat(3_000)}`,
        { continuation: `continue-${index + 1}` },
      ),
    );
    const handoff = buildParentHandoff(runs, {
      ...PARENT_HANDOFF_CAPS,
      aggregateMaxBytes: 1,
    });

    expect(handoff).toContain('Mandatory delegate metadata exceeds');
    for (let index = 1; index <= 20; index++) {
      expect(handoff).toContain(`## Task ${index}\n`);
      expect(handoff).not.toContain(`Conclusion: conclusion ${index}`);
      expect(handoff).not.toContain(`continue-${index}`);
    }
    expect(handoff).not.toContain('### Task 1 report');
  });

  test('uses process-neutral summary wording that cannot contradict Outcome', () => {
    const handoff = buildParentHandoff([
      reportedRun('Outcome: partial\nConclusion: only the audit was completed'),
    ]);

    expect(handoff).not.toContain('Delegated results: 1 run(s)');
    expect(handoff).toContain('Outcome: partial');
    expect(handoff).not.toMatch(
      /Delegated task .*succeeded|Delegated task .*failed/,
    );
  });

  test('does not copy retained child execution activity into parent content', () => {
    const report = 'Outcome: done\nConclusion: only the handoff matters';
    const baseline = reportedRun(report);
    const withActivity = reportedRun(report);
    withActivity.activities.push({
      type: 'thinking',
      label: 'thinking',
      status: 'completed',
      transcriptText: 'private child reasoning',
    });
    withActivity.activities.push({
      type: 'tool',
      label: 'bash',
      status: 'completed',
      toolName: 'bash',
      toolArguments: { command: 'private child command' },
      toolResult: { output: 'private child output' },
    });

    expect(buildParentHandoff([withActivity])).toBe(
      buildParentHandoff([baseline]),
    );
    expect(buildParentHandoff([withActivity])).not.toContain(
      'private child reasoning',
    );
  });

  test('uses a bounded marked fallback when synchronous callers cannot publish a file', () => {
    const handoff = buildParentHandoff(
      [
        reportedRun(
          `Outcome: done\nConclusion: complete\nEvidence: npm test passed; src/cache.ts:42 covers the guard\nRisks: integration coverage remains manual\n\n${'details '.repeat(3_000)}`,
        ),
      ],
      { ...PARENT_HANDOFF_CAPS, singleMaxBytes: 1024 },
    );

    expect(Buffer.byteLength(handoff, 'utf8')).toBeLessThanOrEqual(1024);
    expect(handoff).toContain('Evidence: npm test passed');
    expect(handoff).toContain('Risks: integration coverage remains manual');
    expect(handoff).toContain('Conclusion: complete');
    expect(handoff).toContain('--- begin untrusted delegate report ---');
    expect(handoff).toContain('Output truncated for parent context');
  });

  test('describes active worktree changes as pending finalization', () => {
    const handoff = buildParentHandoff([
      reportedRun('Outcome: done\nConclusion: audit running', {
        worktree: {
          id: '11111111-1111-1111-1111-111111111111',
          branch: 'pi/audit-a1b2',
          worktreePath: '/tmp/worktree',
          repositoryRoot: '/tmp/project',
          baseHead: 'abc123def456',
          workBase: 'abc123def456',
          status: 'active',
          hasWork: false,
        },
      }),
    ]);

    expect(handoff).toContain('changes pending finalization');
    expect(handoff).not.toContain('Branch: pi/audit-a1b2 (no changes');
  });

  test('guides retired read-only snapshots without integration instructions', () => {
    const handoff = buildParentHandoff([
      reportedRun('Outcome: done\nConclusion: review complete', {
        allowWrites: false,
        worktree: {
          id: '11111111-1111-1111-1111-111111111111',
          branch: 'pi/audit-a1b2',
          worktreePath: '/tmp/worktree',
          repositoryRoot: '/tmp/project',
          baseHead: 'abc123def456',
          workBase: 'abc123def456',
          status: 'finished',
          hasWork: false,
          snapshot: true,
        },
      }),
    ]);

    expect(handoff).toContain(
      'Read-only snapshot retained (checkout retired).',
    );
    expect(handoff).toContain('fresh delegate');
    expect(handoff).not.toContain('11111111-1111-1111-1111-111111111111');
    expect(handoff).not.toContain('/delegate-worktrees');
    expect(handoff).not.toContain('refresh');
    expect(handoff).not.toContain('/tmp/worktree');
    expect(handoff).not.toContain('pi/audit-a1b2');
  });

  test('uses only semantic workflow terms for continuation and changes', () => {
    const handoff = buildParentHandoff([
      reportedRun('Outcome: done\nConclusion: implementation complete', {
        continuation: 'opaque-continuation-token',
        workflowAttempt: {
          logicalId: 'reconnect-race-fix',
          ordinal: 2,
          identity: 'reconnect-race-fix@2',
        },
        worktree: {
          id: '11111111-1111-1111-1111-111111111111',
          branch: 'pi/reconnect-race-fix',
          worktreePath: '/repo/.worktrees/reconnect-race-fix',
          repositoryRoot: '/repo',
          baseHead: 'abc123def456',
          workBase: 'abc123def456',
          status: 'finished',
          hasWork: true,
          changedPaths: ['src/reconnect.ts'],
        },
      }),
    ]);

    expect(handoff).toContain('Continue: reconnect-race-fix');
    expect(handoff).toContain(
      'Changes: delegate_changes review/merge/drop node reconnect-race-fix',
    );
    expect(handoff).not.toContain('opaque-continuation-token');
    expect(handoff).not.toContain('11111111-1111-1111-1111-111111111111');
    expect(handoff).not.toContain('pi/reconnect-race-fix');
    expect(handoff).not.toContain('/repo/.worktrees');
    expect(handoff).not.toContain('/delegate-worktrees');
    expect(handoff).not.toContain('refresh');
  });

  test('reports a recovered continuation without warning about its prior run', () => {
    const handoff = buildParentHandoff([
      reportedRun('Outcome: done\nConclusion: completed the recovery', {
        context: 'continuation',
        continuation: 'continue-recovered-child',
        worktree: {
          id: '11111111-1111-1111-1111-111111111111',
          branch: 'pi/recovery-a1b2',
          worktreePath: '/tmp/worktree',
          repositoryRoot: '/tmp/project',
          baseHead: 'abc123def456',
          workBase: 'abc123def456',
          status: 'finished',
          hasWork: true,
          runOutcome: 'timed-out',
          error:
            'The delegate run ended with error; the branch holds whatever work was completed.',
        },
      }),
    ]);

    expect(handoff).toContain(
      'Note: Earlier attempt timed out; this continuation completed in the retained workspace.',
    );
    expect(handoff).not.toContain('Warnings: The delegate run timed out');
  });

  test('does not treat a settlement error as recovery evidence', () => {
    const run = reportedRun(
      'Outcome: done\nConclusion: completed the recovery',
      {
        context: 'continuation',
        worktree: {
          id: '11111111-1111-1111-1111-111111111111',
          branch: 'pi/recovery-a1b2',
          worktreePath: '/tmp/worktree',
          repositoryRoot: '/tmp/project',
          baseHead: 'abc123def456',
          workBase: 'abc123def456',
          status: 'finished',
          hasWork: true,
          error: 'Could not settle the worktree branch: git failed.',
        },
      },
    );

    expect(buildParentHandoff([run])).not.toContain(
      'Earlier attempt timed out; this continuation completed in the retained workspace.',
    );
  });

  test('recovers a successful legacy continuation from its exact error prose', () => {
    const run = reportedRun(
      'Outcome: done\nConclusion: completed the recovery',
      {
        context: 'continuation',
        worktree: {
          id: '11111111-1111-1111-1111-111111111111',
          branch: 'pi/recovery-a1b2',
          worktreePath: '/tmp/worktree',
          repositoryRoot: '/tmp/project',
          baseHead: 'abc123def456',
          workBase: 'abc123def456',
          status: 'finished',
          hasWork: true,
          error:
            'The delegate run timed out; the branch holds whatever work was completed.',
        },
      },
    );

    expect(buildParentHandoff([run])).toContain(
      'Note: Earlier attempt timed out; this continuation completed in the retained workspace.',
    );
  });

  test('keeps a repeated continuation failure as the current outcome', () => {
    const run = createRun('retry the recovery', undefined, {
      context: 'continuation',
      worktree: {
        id: '11111111-1111-1111-1111-111111111111',
        branch: 'pi/recovery-a1b2',
        worktreePath: '/tmp/worktree',
        repositoryRoot: '/tmp/project',
        baseHead: 'abc123def456',
        workBase: 'abc123def456',
        status: 'finished',
        hasWork: true,
        error:
          'The delegate run timed out; the branch holds whatever work was completed.',
      },
    });
    run.state = 'error';
    run.exitCode = 1;
    run.errorMessage = 'Latest continuation failed its checks.';

    const handoff = buildParentHandoff([run]);
    expect(handoff).toContain('Status: error');
    expect(handoff).toContain(
      'Failure: Latest continuation failed its checks.',
    );
    expect(handoff).not.toContain('this continuation completed');
  });

  test('inlines a complete small report without publishing a file', async () => {
    const exact =
      'Outcome: done\nConclusion: the guard is correct\nEvidence: src/guard.ts:10\nRisks: none';
    const run = reportedRun(exact);
    const persisted: string[] = [];
    const put = vi.fn(async (input: string | Uint8Array) => {
      persisted.push(String(input));
      return {
        path: '/tmp/output.md',
        size: Buffer.byteLength(input as string),
      };
    });

    const handoff = await buildOutputFileHandoff([run], put as never);

    expect(put).not.toHaveBeenCalled();
    expect(persisted).toEqual([]);
    expect(run.outputFile).toBeUndefined();
    expect(handoff).toContain(exact);
    expect(handoff).toContain('--- begin untrusted delegate report ---');
    expect(handoff).toContain('--- end untrusted delegate report ---');
    expect(handoff).not.toContain('Output file:');
  });

  test('keeps small fan-in reports inline while publishing only oversized neighbors', async () => {
    const small = 'Outcome: done\nConclusion: small report stays inline';
    const large = `Outcome: done\nConclusion: oversized report\n${'detail '.repeat(3_000)}`;
    const smallRun = reportedRun(small);
    const largeRun = reportedRun(large);
    const put = vi.fn().mockResolvedValue({
      path: '/tmp/large.md',
      size: Buffer.byteLength(large),
    });

    const handoff = await buildOutputFileHandoff(
      [smallRun, largeRun],
      put as never,
    );

    expect(put).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith(large, '.md');
    expect(smallRun.outputFile).toBeUndefined();
    expect(largeRun.outputFile?.path).toBe('/tmp/large.md');
    expect(handoff).toContain(small);
    expect(handoff).toContain(
      `Output file: /tmp/large.md (${Buffer.byteLength(large)} bytes)`,
    );
    expect(handoff).not.toContain(large);
  });

  test('uses a bounded inline fallback when oversized report publication fails', async () => {
    const exact = `Outcome: partial\nConclusion: the report is still available inline\nEvidence: child-check\nRisks: publication failed\n\n${'detail '.repeat(4_000)}`;
    const run = reportedRun(exact);
    const put = vi.fn().mockRejectedValue(new Error('output file unavailable'));

    const handoff = await buildOutputFileHandoff([run], put as never);

    expect(put).toHaveBeenCalledOnce();
    expect(handoff).toContain('Inline fallback (output file unavailable)');
    expect(handoff).toContain('Outcome: partial');
    expect(handoff).toContain('Output truncated for parent context');
    expect(handoff).toContain('Warnings: Exact output file unavailable');
    expect(handoff).toContain('--- begin untrusted delegate report ---');
    expect(handoff).not.toContain(exact);
    expect(run.outputFile).toBeUndefined();
    expect(run.state).toBe('success');
  });

  test('preserves the exact long report in the output file', async () => {
    const exact = `Outcome: done\nConclusion: complete\n\n${'🙂'.repeat(10_000)}`;
    const run = reportedRun(exact);
    const persisted: string[] = [];
    const put = vi.fn(async (input: string | Uint8Array) => {
      persisted.push(String(input));
      return {
        path: '/tmp/output.md',
        size: Buffer.byteLength(input as string),
      };
    });

    const handoff = await buildOutputFileHandoff([run], put as never);

    expect(put).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual([exact]);
    expect(run.outputFile).toEqual({
      path: '/tmp/output.md',
      size: Buffer.byteLength(exact),
    });
    expect(handoff).toContain(
      `Output file: /tmp/output.md (${Buffer.byteLength(exact)} bytes)`,
    );
  });

  test('preserves mandatory UTF-8 envelopes when they exceed a cap', () => {
    const continuation = `continue-${'界'.repeat(600)}`;
    const handoff = buildParentHandoff(
      [
        reportedRun(
          'Outcome: blocked\nConclusion: a decision is required\nBlocked: choose one implementation',
          { continuation },
        ),
      ],
      { ...PARENT_HANDOFF_CAPS, singleMaxBytes: 1 },
    );

    expect(Buffer.byteLength(handoff, 'utf8')).toBeGreaterThan(1);
    expect(handoff).toContain('Mandatory delegate metadata exceeds');
    expect(handoff).toContain(
      'Continuation available in the retained child context.',
    );
    expect(handoff).not.toContain(continuation);
    expect(handoff).not.toContain('Conclusion: a decision is required');
  });

  test('uses the restored safety bounds', () => {
    expect(PARENT_HANDOFF_CAPS).toEqual({
      singleMaxBytes: 12 * 1024,
      aggregateMaxBytes: 50 * 1024,
      perTaskMaxBytes: 8 * 1024,
    });
  });
});
