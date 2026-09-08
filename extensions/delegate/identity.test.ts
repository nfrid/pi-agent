import { describe, expect, it } from 'vitest';
import { deriveCompatibilityRunId } from './identity';

describe('delegate compatibility identity', () => {
  it('preserves the distinct legacy run identity derived from extension run facts', () => {
    expect(
      deriveCompatibilityRunId({
        continuation: 'legacy-token',
        task: 'review',
        queuedAt: 123,
      }),
    ).toBe('dr-3cb19527a906fa659a3bec3defc28797');
  });
});
