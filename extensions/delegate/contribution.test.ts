import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import {
  DELEGATE_RENDERER_ID,
  DelegateStatusViewModelSchema,
  delegateCapabilitySnapshot,
  delegateManifest,
} from './contribution';

describe('delegate live contribution', () => {
  it('advertises a typed renderer and validates a bounded status model', () => {
    expect(delegateManifest.renderers.map((renderer) => renderer.id)).toEqual([
      DELEGATE_RENDERER_ID,
    ]);
    expect(delegateCapabilitySnapshot.manifests[0]?.renderers[0]?.id).toBe(
      DELEGATE_RENDERER_ID,
    );
    expect(
      Value.Check(DelegateStatusViewModelSchema, {
        version: 1,
        statuses: [
          {
            id: 'ds-1',
            runId: 'run-1',
            lineageId: 'lineage-1',
            name: 'Review',
            kind: 'foreground',
            state: 'running',
            createdAt: 1,
            allowWrites: false,
            usage: {
              input: 100,
              output: 25,
              cacheRead: 10,
              cacheWrite: 5,
              contextTokens: 120,
              cost: 0.0123,
              turns: 2,
              contextWindow: 272000,
            },
            activity: {
              type: 'thinking',
              label: 'Checking files',
              status: 'running',
            },
            transcript: [
              {
                id: 'tool-1',
                type: 'tool',
                label: 'run checks',
                name: 'bash',
                arguments: { command: 'pnpm test' },
                result: { exitCode: 0 },
                status: 'completed',
              },
            ],
            workflow: {
              logicalId: 'review',
              attempt: 1,
              identity: 'review@1',
              state: 'scheduled',
              dependencies: ['impl@1'],
              waitingFor: ['impl@1'],
              reason: 'waiting for impl@1',
              createdAt: 1,
              scheduledAt: 1,
            },
          },
        ],
        wakes: [
          {
            id: 'review-ready',
            state: 'pending',
            references: ['review@1'],
            waitingFor: ['review@1'],
            createdAt: 1,
          },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(DelegateStatusViewModelSchema, {
        version: 1,
        statuses: [
          {
            id: 'ds-1',
            runId: 'run-1',
            lineageId: 'lineage-1',
            name: 'Review',
            kind: 'foreground',
            state: 'running',
            createdAt: 1,
            allowWrites: false,
            workflow: {
              logicalId: 'review',
              attempt: 1,
              identity: 'review@1',
              state: 'blocked',
              dependencies: [],
              reason: 'missing input',
              createdAt: 1,
              scheduledAt: 1,
            },
          },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(DelegateStatusViewModelSchema, {
        version: 1,
        statuses: [
          {
            id: 'ds-2',
            runId: 'run-2',
            lineageId: 'lineage-2',
            name: 'Invalid workflow',
            kind: 'background',
            state: 'queued',
            createdAt: 1,
            allowWrites: false,
            workflow: {
              logicalId: 'review',
              attempt: 1,
              identity: 'review@1',
              state: 'running',
              dependencies: [],
              report: 'must not be accepted',
              createdAt: 1,
              scheduledAt: 1,
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      Value.Check(DelegateStatusViewModelSchema, {
        version: 1,
        statuses: [
          {
            id: 'ds-2',
            runId: 'run-2',
            lineageId: 'lineage-2',
            name: 'Oversized',
            kind: 'foreground',
            state: 'running',
            createdAt: 1,
            allowWrites: false,
            transcript: [
              {
                id: 'tool-1',
                type: 'tool',
                label: 'run checks',
                arguments: { command: 'x'.repeat(1_025) },
              },
            ],
          },
        ],
      }),
    ).toBe(false);
  });
});
