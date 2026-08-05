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
            name: 'Review',
            kind: 'foreground',
            state: 'running',
            createdAt: 1,
            allowWrites: false,
            activity: {
              type: 'thinking',
              label: 'Checking files',
              status: 'running',
            },
          },
        ],
      }),
    ).toBe(true);
  });
});
