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

    expect(inspected.text.length).toBeLessThanOrEqual(
      DELEGATE_INSPECT_MAX_TEXT,
    );
    expect(inspected.text).toContain(
      'tool write [completed] — path=/tmp/result.txt',
    );
    expect(inspected.text).toContain('tool bash [completed] — command=printf');
    expect(inspected.text).toContain(
      'command=write operation (details omitted)',
    );
    expect(inspected.text).not.toContain('secret patch content');
    expect(inspected.text).not.toContain('old continuation activity');
    expect(inspected.text).not.toContain('raw reasoning');
    expect(inspected.text).not.toContain('DO NOT EXPOSE');
    expect(inspected.text).not.toContain('hidden result');
    expect(inspected.text).toContain('omitted/truncated');
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
