import { describe, expect, test, vi } from 'vitest';
import {
  buildParentHandoff,
  PARENT_HANDOFF_CAPS,
  truncateBytes,
} from './output';
import { buildArtifactBackedHandoff } from './tool-result';
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

function artifact() {
  return {
    handle: `art_${'d'.repeat(22)}`,
    sha256: 'a'.repeat(64),
    size: 1,
    producer: 'delegate' as const,
    contentClass: 'delegate-output' as const,
    creationSource: 'delegate.result',
    encoding: 'utf-8' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('output', () => {
  test('truncates by UTF-8 bytes', () => {
    const output = truncateBytes('🙂'.repeat(100), 100);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(100);
    expect(output).toContain('Output truncated');
  });

  test('keeps a blocker and its continuation when no body fits', () => {
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

    expect(handoff).toContain('Outcome: blocked');
    expect(handoff).toContain(
      'Conclusion: implementation needs a parent decision',
    );
    expect(handoff).toContain(
      'Blocked: should a 429 retry despite the stated never-retry rule?',
    );
    expect(handoff).toContain('Continuation: continue-blocked-child');
    expect(handoff).toContain('Mandatory metadata exceeds');
    expect(handoff).not.toContain('Output\nOutcome: blocked');
  });

  test('keeps every conclusion in a maximum-width parallel fan when bodies cannot fit', () => {
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

    expect(handoff).toContain('Mandatory metadata exceeds');
    for (let index = 1; index <= 20; index++) {
      expect(handoff).toContain(`## Task ${index}\n`);
      expect(handoff).toContain(`Conclusion: conclusion ${index}`);
      expect(handoff).toContain(`Continuation: continue-${index}`);
    }
    expect(handoff).not.toContain('### Task 1 output');
  });

  test('uses process-neutral summary wording that cannot contradict Outcome', () => {
    const handoff = buildParentHandoff([
      reportedRun('Outcome: partial\nConclusion: only the audit was completed'),
    ]);

    expect(handoff).toContain('Delegated results: 1 run(s)');
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

  test('keeps evidence and risks in the mandatory envelope', () => {
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
      'Read-only snapshot: 11111111-1111-1111-1111-111111111111 (checkout retired)',
    );
    expect(handoff).toContain(
      'Cleanup: delegate_branches drop 11111111-1111-1111-1111-111111111111',
    );
    expect(handoff).toContain('refresh wip or head');
    expect(handoff).toContain('fresh delegate');
    expect(handoff).not.toContain('abc123de (checkout retired)');
    expect(handoff).not.toContain('Integrate with:');
    expect(handoff).not.toContain('Branch: pi/audit-a1b2');
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
      'Note: Earlier attempt timed out; this continuation completed on the same branch.',
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
      'Earlier attempt timed out; this continuation completed on the same branch.',
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
      'Note: Earlier attempt timed out; this continuation completed on the same branch.',
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

  test('artifacts every exact report and keeps the parent result envelope-only', async () => {
    const exact =
      'Outcome: done\nConclusion: the guard is correct\nEvidence: src/guard.ts:10\nRisks: none';
    const run = reportedRun(exact);
    const persisted: string[] = [];
    const put = vi.fn(
      async (_pi: unknown, _ctx: unknown, input: { bytes: string }) => {
        persisted.push(input.bytes);
        return { ...artifact(), size: Buffer.byteLength(input.bytes) };
      },
    );

    const handoff = await buildArtifactBackedHandoff(
      {} as never,
      {} as never,
      [run],
      put as never,
    );

    expect(put).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual([exact]);
    expect(run.artifact?.handle).toBe(artifact().handle);
    expect(handoff).toContain(`Artifact: ${artifact().handle}`);
    expect(handoff).toContain('Truncation: original report omitted');
    expect(handoff).not.toContain(`Output\n${exact}`);
    expect(handoff).not.toContain(exact);
  });

  test('uses a bounded inline fallback when artifact publication fails', async () => {
    const exact =
      'Outcome: partial\nConclusion: the report is still available inline\nEvidence: child-check\nRisks: publication failed';
    const run = reportedRun(exact);
    const put = vi.fn().mockRejectedValue(new Error('artifact unavailable'));

    const handoff = await buildArtifactBackedHandoff(
      {} as never,
      {} as never,
      [run],
      put as never,
    );

    expect(handoff).toContain('Inline fallback (artifact unavailable)');
    expect(handoff).toContain(exact);
    expect(handoff).not.toContain('Artifact:');
    expect(handoff).toContain('Warnings: Exact output artifact unavailable');
    expect(run.artifact).toBeUndefined();
  });

  test('preserves the exact omitted report in the output artifact', async () => {
    const exact = `Outcome: done\nConclusion: complete\n\n${'🙂'.repeat(10_000)}`;
    const run = reportedRun(exact);
    const persisted: string[] = [];
    const put = vi.fn(
      async (_pi: unknown, _ctx: unknown, input: { bytes: string }) => {
        persisted.push(input.bytes);
        return { ...artifact(), size: Buffer.byteLength(input.bytes) };
      },
    );

    const handoff = await buildArtifactBackedHandoff(
      {} as never,
      {} as never,
      [run],
      put as never,
    );

    expect(put).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual([exact]);
    expect(run.artifact?.handle).toBe(artifact().handle);
    expect(handoff).toContain(`Artifact: ${artifact().handle}`);
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
    expect(handoff).toContain('Mandatory metadata exceeds');
    expect(handoff).toContain(`Continuation: ${continuation}`);
    expect(handoff).toContain('Conclusion: a decision is required');
  });

  test('uses the restored safety bounds', () => {
    expect(PARENT_HANDOFF_CAPS).toEqual({
      singleMaxBytes: 12 * 1024,
      aggregateMaxBytes: 50 * 1024,
      perTaskMaxBytes: 8 * 1024,
    });
  });
});
