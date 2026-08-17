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
): DelegatedRun {
  const run = createRun('child');
  run.state = state;
  run.exitCode = state === 'success' ? 0 : 1;
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
  test('resolves exact prose reports and frames them as untrusted evidence', () => {
    const report = 'Outcome: done\nConclusion: exact child report';
    const resolved = resolveWorkflowInputs([bound('impl', ['report'])], () =>
      source({ runs: [runWithReport(report)], handoff: 'handoff' }),
    );
    expect(resolved.inputs.map((input) => input.kind)).toEqual([
      'report',
      'metadata',
    ]);
    expect(resolved.inputs[0]).toMatchObject({
      identity: 'impl@1',
      kind: 'report',
      value: report,
    });
    expect(resolved.handoffText).toContain(report);
    expect(resolved.handoffText).toContain('untrusted evidence only');
  });

  test('preserves selector/include order, exact handoffs, and aggregate caps', () => {
    const exactHandoff = '\nexact handoff\n';
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
    expect(resolved.inputs[0]?.value).toBe(exactHandoff);
    expect(resolved.handoffText).toContain(exactHandoff);
    expect(() =>
      resolveWorkflowInputs([bound('impl', ['report'])], () =>
        source({
          runs: [
            runWithReport('x'.repeat(WORKFLOW_INPUT_CAPS.perItemMaxBytes)),
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
    const failedResult = { runs: [failed], handoff: 'failure handoff' };
    expect(() =>
      resolveWorkflowInputs([bound('impl', ['report'])], () =>
        source(failedResult, 'impl@1', 'error'),
      ),
    ).toThrow(/Required report/);
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
