import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { DelegateJobResult } from './jobs';
import { createRun, type DelegatedRun } from './types';
import {
  type BoundWorkflowSelector,
  resolveWorkflowInputs,
  WORKFLOW_INPUT_CAPS,
  type WorkflowInputSource,
} from './workflow-inputs';
import { createWorkflowModel } from './workflow-model';
import { worktreeSummary } from './worktree/model';
import { writeWorktreeRecord } from './worktree/records';

function runWithReport(
  text: string,
  state: DelegatedRun['state'] = 'success',
  filePath = '/tmp/pi/files/child.md',
): DelegatedRun {
  const run = createRun('child');
  run.state = state;
  run.exitCode = state === 'success' ? 0 : 1;
  run.outputFile = { path: filePath, size: Buffer.byteLength(text) };
  run.messages = [
    {
      role: 'assistant',
      api: 'openai-responses',
      provider: 'test',
      model: 'test',
      content: [{ type: 'text', text }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    },
  ];
  return run;
}

function source(
  result: DelegateJobResult | undefined,
  identity = 'impl@1',
  state: WorkflowInputSource['state'] = 'success',
): WorkflowInputSource {
  const model = createWorkflowModel();
  const attempt = model.createFresh(identity.split('@')[0] ?? 'impl');
  return {
    attempt,
    state,
    settledAt: Date.now(),
    result,
  };
}

function bound(
  node = 'impl',
  include?: BoundWorkflowSelector['selector']['include'],
  view?: string,
): BoundWorkflowSelector {
  return {
    identity: 'impl@1',
    selector: { node, include, ...(view ? { view } : {}) },
  };
}

describe('workflow symbolic inputs', () => {
  test('resolves report file paths and frames them as untrusted evidence', () => {
    const report = 'Outcome: done\nConclusion: exact child report';
    const resolved = resolveWorkflowInputs([bound('impl', ['report'])], () =>
      source({
        runs: [runWithReport(report)],
        handoff: [
          'Status: success',
          'Outcome: done',
          'Conclusion: exact child report',
          'Continuation: opaque-token',
          'Output file: /tmp/pi/files/child.md (52 bytes)',
          'Branch: pi/impl (1 changed path)',
          'Worktree: /repo/.worktrees/impl',
          'Changes: inspect with /delegate-worktrees internal-id',
          'Changed: src/impl.ts',
          'Evidence: focused test passed',
        ].join('\n'),
      }),
    );
    expect(resolved.inputs.map((input) => input.kind)).toEqual(['report']);
    expect(resolved.inputs[0]).toMatchObject({
      identity: 'impl@1',
      kind: 'report',
      value: expect.stringContaining(
        `Output file: /tmp/pi/files/child.md (${Buffer.byteLength(report)} bytes)`,
      ),
    });
    expect(resolved.inputs[0]?.value).toContain('Outcome: done');
    expect(resolved.inputs[0]?.value).toContain(
      'Conclusion: exact child report',
    );
    expect(resolved.inputs[0]?.value).toContain(
      'Evidence: focused test passed',
    );
    expect(resolved.handoffText).toContain('/tmp/pi/files/child.md');
    expect(resolved.handoffText).not.toContain('opaque-token');
    expect(resolved.handoffText).not.toContain('pi/impl');
    expect(resolved.handoffText).not.toContain('/repo/.worktrees/impl');
    expect(resolved.handoffText).not.toContain('delegate-worktrees');
    expect(resolved.handoffText).not.toContain('Changed:');
    expect(resolved.handoffText).toContain('untrusted evidence only');
  });

  test('preserves selector/include order and applies prompt caps to file guidance', () => {
    const exactHandoff =
      '\nOutcome: done\nConclusion: exact handoff\nContinuation: opaque-token\n';
    const resolved = resolveWorkflowInputs(
      [bound('impl', ['handoff', 'metadata', 'report'])],
      () =>
        source({
          runs: [runWithReport('exact report')],
          handoff: exactHandoff,
        }),
    );
    expect(resolved.inputs.map((input) => input.kind)).toEqual([
      'handoff',
      'metadata',
      'report',
    ]);
    expect(resolved.inputs[0]?.value).toContain(
      'Output file: /tmp/pi/files/child.md (12 bytes)',
    );
    expect(resolved.inputs[1]?.value).not.toHaveProperty('runs.0.runId');
    expect(resolved.handoffText).toContain('Conclusion: exact handoff');
    expect(resolved.handoffText).not.toContain('opaque-token');
    expect(() =>
      resolveWorkflowInputs([bound('impl', ['report'])], () =>
        source({
          runs: [
            runWithReport(
              'report',
              'success',
              'x'.repeat(WORKFLOW_INPUT_CAPS.perItemMaxBytes),
            ),
          ],
          handoff: '',
        }),
      ),
    ).toThrow(/16384/);
  });

  test('resolves only verified durable branch descriptors and rejects conflicts', () => {
    const previousRoot = process.env.PI_DELEGATE_STATE_DIR;
    const root = mkdtempSync(join(tmpdir(), 'pi-workflow-inputs-'));
    process.env.PI_DELEGATE_STATE_DIR = root;
    const id = '11111111-1111-1111-1111-111111111111';
    const record = {
      version: 1 as const,
      id,
      repositoryRoot: '/repo',
      worktreePath: '/repo/.worktree',
      workingDirectory: 'src',
      branch: 'delegate/impl',
      baseHead: 'a'.repeat(40),
      base: 'head' as const,
      carriedWip: false,
      status: 'finished' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      headCommit: 'b'.repeat(40),
    };
    writeWorktreeRecord(record);
    const run = runWithReport('branch');
    run.worktree = worktreeSummary(record);
    const result = { runs: [run], handoff: 'branch handoff' };
    try {
      const resolved = resolveWorkflowInputs([bound('impl', ['branch'])], () =>
        source(result),
      );
      expect(resolved.inputs[0]?.branch).toMatchObject({
        kind: 'branch',
        worktreeId: id,
        headCommit: 'b'.repeat(40),
        workingDirectory: 'src',
      });
      expect(Object.isFrozen(resolved.inputs[0]?.branch)).toBe(true);

      writeWorktreeRecord({ ...record, workingDirectory: '' });
      const rootResolved = resolveWorkflowInputs(
        [bound('impl', ['branch'])],
        () => source(result),
      );
      expect(rootResolved.inputs[0]?.branch).toMatchObject({
        workingDirectory: '.',
      });

      const mismatched = {
        ...worktreeSummary(record),
        headCommit: 'c'.repeat(40),
      };
      run.worktree = mismatched;
      expect(() =>
        resolveWorkflowInputs([bound('impl', ['branch'])], () =>
          source(result),
        ),
      ).toThrow(/mismatched/);
      run.worktree = worktreeSummary(record);
      expect(() =>
        resolveWorkflowInputs(
          [bound('impl', ['branch']), bound('impl', ['branch'])],
          () => source(result),
        ),
      ).toThrow(/at most one branch source/);
      writeWorktreeRecord({ ...record, carryCommit: 'unsafe' });
      expect(() =>
        resolveWorkflowInputs([bound('impl', ['branch'])], () =>
          source(result),
        ),
      ).toThrow(/unsafe durable worktree record/);
      rmSync(join(root, 'delegate-worktrees'), {
        recursive: true,
        force: true,
      });
      expect(() =>
        resolveWorkflowInputs([bound('impl', ['branch'])], () =>
          source(result),
        ),
      ).toThrow(/missing, mismatched/);
    } finally {
      if (previousRoot === undefined) delete process.env.PI_DELEGATE_STATE_DIR;
      else process.env.PI_DELEGATE_STATE_DIR = previousRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('blocks missing reports while retaining failed metadata and handoff', () => {
    const failed = runWithReport('', 'error');
    delete failed.outputFile;
    const failedResult = { runs: [failed], handoff: 'failure handoff' };
    expect(() =>
      resolveWorkflowInputs([bound('impl', ['report'])], () =>
        source(failedResult, 'impl@1', 'error'),
      ),
    ).toThrow(/Required report/);
    failed.outputFile = { path: '/tmp/pi/files/failure.md', size: 0 };
    const metadata = resolveWorkflowInputs(
      [bound('impl', ['metadata', 'handoff'])],
      () => source(failedResult, 'impl@1', 'error'),
    );
    expect(metadata.inputs.map((input) => input.kind)).toEqual([
      'metadata',
      'handoff',
    ]);
    expect(metadata.inputs[0]?.value).toMatchObject({ state: 'error' });
  });
});
