import { describe, expect, test } from 'vitest';
import { DELEGATE_INSPECT_MAX_TEXT, inspectDelegateTarget } from './inspect';
import type { DelegateStatusSnapshot } from './status';

function status(
  overrides: Partial<DelegateStatusSnapshot> = {},
): DelegateStatusSnapshot {
  return {
    id: 'ds-1',
    runId: 'run-2',
    lineageId: 'lineage-1',
    name: 'worker',
    kind: 'background',
    state: 'running',
    allowWrites: true,
    createdAt: 100,
    runCount: 2,
    transcript: [],
    ...overrides,
  };
}

describe('delegate activity inspection', () => {
  test('bounds activity, excludes thinking/results, and allowlists tool arguments', () => {
    const current = Array.from({ length: 14 }, (_, index) => ({
      id: `tool-${index}`,
      type: 'tool' as const,
      label: 'write secret payload',
      name: index === 13 ? 'write' : 'bash',
      arguments:
        index === 13
          ? { path: '/tmp/result.txt', content: 'DO NOT EXPOSE' }
          : index === 12
            ? { command: 'apply_patch secret patch content' }
            : { command: `printf ${'x'.repeat(500)}` },
      result: `hidden result ${index}`,
      status: 'completed' as const,
      at: 200 + index,
      run: 2,
    }));
    const inspected = inspectDelegateTarget(
      {
        reference: 'node@2',
        state: 'running',
        status: status({
          transcript: [
            {
              id: 'old',
              type: 'assistant',
              label: 'Response',
              text: 'old continuation activity',
              at: 110,
              run: 1,
            },
            {
              id: 'thinking',
              type: 'thinking',
              label: 'Reasoning',
              text: 'raw reasoning must stay hidden',
              at: 190,
              run: 2,
            },
            ...current,
          ],
        }),
      },
      1_000,
    );

    expect(Buffer.byteLength(inspected.text, 'utf8')).toBeLessThanOrEqual(
      DELEGATE_INSPECT_MAX_TEXT,
    );
    expect(inspected.text).toContain(
      'tool write [completed] — path=/tmp/result.txt',
    );
    expect(inspected.text).toContain('tool bash [completed] — command=printf');
    expect(inspected.text).toContain('command=apply_patch (details omitted)');
    expect(inspected.text).not.toContain('secret patch content');
    expect(inspected.text).not.toContain('old continuation activity');
    expect(inspected.text).not.toContain('raw reasoning');
    expect(inspected.text).not.toContain('DO NOT EXPOSE');
    expect(inspected.text).not.toContain('hidden result');
    expect(inspected.text).toContain('omitted/truncated');
    expect(inspected.text).toContain('last recorded activity (event start):');
    expect(inspected.text).not.toContain('ago)');
  });

  test('reports unavailable queued activity and metadata-only settled state', () => {
    const queued = inspectDelegateTarget({
      reference: 'queued',
      state: 'queued',
    });
    expect(queued.text).toContain('queued');
    expect(queued.text).toContain('activity: unavailable');

    const settled = inspectDelegateTarget({
      reference: 'done',
      state: 'success',
      status: status({
        state: 'success',
        finishedAt: 400,
        transcript: [
          {
            id: 'report',
            type: 'assistant',
            label: 'Response',
            text: 'final report must not be exposed',
            at: 390,
            run: 2,
          },
        ],
      }),
    });
    expect(settled.text).toContain('metadata only');
    expect(settled.text).not.toContain('final report');
    expect(settled.details.activity).toBe('settled');
  });

  test('treats settled workflow or job state as metadata-only despite stale live status', () => {
    const workflowSettled = inspectDelegateTarget({
      reference: 'workflow-settled',
      state: 'running',
      workflow: { state: 'success', settledAt: 500 } as never,
      status: status({
        state: 'running',
        transcript: [
          {
            id: 'final',
            type: 'assistant',
            label: 'Response',
            text: 'stale final report',
            at: 490,
            run: 2,
          },
        ],
      }),
    });
    expect(workflowSettled.text).toContain('workflow-settled: success');
    expect(workflowSettled.text).toContain('metadata only');
    expect(workflowSettled.text).not.toContain('stale final report');

    const jobSettled = inspectDelegateTarget({
      reference: 'job-settled',
      state: 'running',
      job: { state: 'success', settledAt: 500 } as never,
      status: status({ state: 'running' }),
    });
    expect(jobSettled.text).toContain('job-settled: success');
    expect(jobSettled.text).toContain('metadata only');
  });

  test('scopes error information to the current invocation', () => {
    const inspected = inspectDelegateTarget({
      reference: 'failed@2',
      state: 'error',
      status: status({
        state: 'error',
        transcript: [
          {
            id: 'old-error',
            type: 'error',
            label: 'Error',
            text: 'old continuation error',
            at: 200,
            run: 1,
          },
          {
            id: 'current-error',
            type: 'error',
            label: 'Error',
            text: 'current invocation error',
            at: 300,
            run: 2,
          },
        ],
      }),
    });
    expect(inspected.text).toContain('error: current invocation error');
    expect(inspected.text).not.toContain('old continuation error');
  });

  test('clips Unicode without exceeding the byte bound or splitting surrogates', () => {
    const inspected = inspectDelegateTarget({
      reference: 'unicode',
      state: 'running',
      status: status({
        runCount: 1,
        transcript: Array.from({ length: 10 }, (_, index) => ({
          id: `unicode-${index}`,
          type: 'tool' as const,
          name: 'grep',
          label: 'grep',
          arguments: { pattern: '🙂'.repeat(500), path: '🙂'.repeat(500) },
          at: 300 + index,
          run: 1,
        })),
      }),
    });
    expect(Buffer.byteLength(inspected.text, 'utf8')).toBeLessThanOrEqual(
      DELEGATE_INSPECT_MAX_TEXT,
    );
    expect(inspected.text).toContain('inspect snapshot truncated');
    for (let index = 0; index < inspected.text.length; index++) {
      const code = inspected.text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff)
        expect(inspected.text.charCodeAt(index + 1)).toBeGreaterThanOrEqual(
          0xdc00,
        );
      if (code >= 0xdc00 && code <= 0xdfff)
        expect(inspected.text.charCodeAt(index - 1)).toBeGreaterThanOrEqual(
          0xd800,
        );
    }
  });

  test('summarizes shell activity without copying inline payloads or unknown labels', () => {
    const commands = [
      { command: 'cat source.ts' },
      { command: 'python -c "secret script"' },
      { command: `printf ${'secret'.repeat(100)} > result.txt` },
      {
        command: 'apply_patch secret patch',
        description: 'Update the regression fixture',
      },
    ];
    const inspected = inspectDelegateTarget({
      reference: 'shell-summary',
      state: 'running',
      status: status({
        runCount: 1,
        transcript: [
          ...commands.map((args, index) => ({
            id: `shell-${index}`,
            type: 'tool' as const,
            name: 'bash',
            label: 'bash',
            arguments: args,
            status: 'running' as const,
            run: 1,
          })),
          {
            id: 'unknown',
            type: 'tool',
            label: 'secret unknown payload',
            run: 1,
          },
        ],
      }),
    });
    expect(inspected.text).toContain('command=cat source.ts');
    expect(inspected.text).toContain('command=python (details omitted)');
    expect(inspected.text).toContain('command=printf (details omitted)');
    expect(inspected.text).toContain(
      'description=Update the regression fixture',
    );
    expect(inspected.text).toContain('tool unknown');
    expect(inspected.text).not.toContain('secret');
  });

  test('includes bounded error information without exposing result payloads', () => {
    const inspected = inspectDelegateTarget({
      reference: 'failed@1',
      state: 'error',
      status: status({
        state: 'error',
        lifecycle: {
          reason: 'provider-runner-error',
          diagnostic: 'provider unavailable',
          continuationUsable: true,
          writableBranchRetained: false,
          readOnlySnapshotRetained: true,
        },
        transcript: [
          {
            id: 'error',
            type: 'error',
            label: 'Error',
            text: 'provider unavailable',
            at: 300,
            run: 2,
          },
        ],
      }),
    });
    expect(inspected.text).toContain('error: provider unavailable');
    expect(inspected.text).not.toContain('provider-runner-error');
  });
});
