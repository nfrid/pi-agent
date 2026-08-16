import { describe, expect, test } from 'vitest';
import {
  createWorkflowModel,
  isLogicalId,
  MAX_LOGICAL_ID_LENGTH,
  normalizeWorkflowAttempt,
  parseWorkflowReference,
} from './workflow-model';

describe('WorkflowModel', () => {
  test('numbers fresh and continuation attempts in one lineage', () => {
    const model = createWorkflowModel();

    expect(model.createFresh('impl')).toMatchObject({
      logicalId: 'impl',
      ordinal: 1,
      identity: 'impl@1',
    });
    expect(model.continue('impl')).toMatchObject({
      logicalId: 'impl',
      ordinal: 2,
      identity: 'impl@2',
    });
    expect(model.createFresh('review')).toMatchObject({ identity: 'review@1' });
  });

  test('binds bare references to the latest attempt at bind time', () => {
    const model = createWorkflowModel();
    model.createFresh('impl');

    const firstBinding = model.bind('impl');
    model.continue('impl');

    expect(firstBinding.identity).toBe('impl@1');
    expect(model.bind('impl').identity).toBe('impl@2');
  });

  test('binds exact references immutably', () => {
    const model = createWorkflowModel();
    model.createFresh('impl');
    model.continue('impl');

    expect(model.bind('impl@1')).toMatchObject({
      logicalId: 'impl',
      ordinal: 1,
      identity: 'impl@1',
    });
    expect(model.lookup('impl@2').identity).toBe('impl@2');
  });

  test('rejects unknown, malformed, and duplicate references fail closed', () => {
    const model = createWorkflowModel();

    expect(() => model.continue('missing')).toThrow(/Unknown logical ID/);
    expect(() => model.bind('missing')).toThrow(/Unknown logical ID/);
    expect(() => model.bind('impl@1')).toThrow(/Unknown logical ID/);
    expect(() => model.createFresh('impl')).not.toThrow();
    expect(() => model.createFresh('impl')).toThrow(/already exists/);
    expect(() => model.bind('impl@2')).toThrow(/Unknown attempt/);

    for (const reference of [
      '',
      'Impl',
      'impl_name',
      '-impl',
      'impl-',
      'impl@0',
      'impl@01',
      'impl@one',
      'impl@1@2',
      'impl/other',
    ])
      expect(() => model.bind(reference), reference).toThrow(
        /Invalid workflow reference/,
      );
  });

  test('enforces strict bounded logical IDs', () => {
    expect(isLogicalId('a')).toBe(true);
    expect(isLogicalId('worker-2')).toBe(true);
    expect(isLogicalId('A')).toBe(false);
    expect(isLogicalId('worker--2')).toBe(false);
    expect(isLogicalId('worker_2')).toBe(false);
    expect(isLogicalId('x'.repeat(MAX_LOGICAL_ID_LENGTH + 1))).toBe(false);
    expect(() => createWorkflowModel().createFresh('A')).toThrow(
      /lowercase kebab-case/,
    );
  });

  test('does not leak mutable records through snapshots or bindings', () => {
    const model = createWorkflowModel();
    model.createFresh('impl');
    const snapshot = model.snapshot();
    const binding = model.bind('impl');

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.attempts)).toBe(true);
    expect(Object.isFrozen(snapshot.attempts[0])).toBe(true);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(() => {
      const first = (snapshot.attempts as unknown as { ordinal: number }[])[0];
      if (first) first.ordinal = 9;
    }).toThrow();
    expect(model.bind('impl').ordinal).toBe(1);
    expect(model.snapshot().attempts).toEqual([
      { logicalId: 'impl', ordinal: 1, identity: 'impl@1' },
    ]);
  });

  test('validates and freezes attempts at adapter boundaries', () => {
    const normalized = normalizeWorkflowAttempt({
      logicalId: 'impl',
      ordinal: 2,
      identity: 'impl@2',
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(normalized).toEqual({
      logicalId: 'impl',
      ordinal: 2,
      identity: 'impl@2',
    });
    expect(() =>
      normalizeWorkflowAttempt({
        logicalId: 'impl',
        ordinal: 2,
        identity: 'impl@1',
      }),
    ).toThrow(/logical ID, ordinal, and identity must agree/);
    expect(() =>
      normalizeWorkflowAttempt({
        logicalId: 'Impl',
        ordinal: 1,
        identity: 'Impl@1',
      }),
    ).toThrow(/logical ID, ordinal, and identity must agree/);
  });

  test('parses bare and exact references distinctly', () => {
    expect(parseWorkflowReference('impl')).toEqual({ logicalId: 'impl' });
    expect(parseWorkflowReference('impl@12')).toEqual({
      logicalId: 'impl',
      ordinal: 12,
    });
  });
});
