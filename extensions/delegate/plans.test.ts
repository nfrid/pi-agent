import { describe, expect, test } from 'vitest';
import { assertContinuationFields } from './plans';
import { createWorkflowModel } from './workflow-model';

describe('delegate continuation parameter preflight', () => {
  test('rejects inherited replacements without advancing the lineage', () => {
    const model = createWorkflowModel();
    model.createFresh('lineage');

    expect(() =>
      assertContinuationFields(
        'lineage',
        { cwd: '/tmp/other-project' },
        'A continuation reuses its original cwd, context, scope, and base; do not provide replacements.',
      ),
    ).toThrow(
      'A continuation reuses its original cwd, context, scope, and base; do not provide replacements.',
    );
    expect(model.snapshot().attempts.map(({ identity }) => identity)).toEqual([
      'lineage@1',
    ]);
    expect(model.continue('lineage').identity).toBe('lineage@2');
  });
});
