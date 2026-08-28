import { describe, expect, test } from 'vitest';
import {
  mergeWakeRestoreRecords,
  needsWakeReloadBlock,
  normalizeWakeCondition,
  normalizeWakePayload,
  parseWakeRestoreSnapshot,
  type WakeRestorePolicyOptions,
  type WakeRestoreRecord,
} from './wake-restore-policy';

const options: WakeRestorePolicyOptions = {
  version: 1,
  ownerSessionId: 'owner',
  ownerEpoch: 2,
  maxSubscriptions: 4,
  maxConditionReferences: 32,
  maxPayloadSelectors: 8,
  wakeIdMaxLength: 64,
  wakeIdPattern: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  currentWorkflowLookup: (identity) =>
    identity === 'done@1'
      ? {
          identity,
          attempt: { logicalId: 'done', ordinal: 1, identity },
          logicalId: 'done',
          ordinal: 1,
          dependencies: [],
          waitingFor: [],
          inputs: [],
          state: 'success',
          createdAt: 1,
          scheduledAt: 1,
        }
      : undefined,
};

function snapshot(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'wake',
    ownerSessionId: 'owner',
    ownerEpoch: 2,
    deliveryKey: 'owner:2:wake',
    condition: { node: 'done@1' },
    references: ['done@1'],
    payload: ['metadata'],
    nonObstructive: false,
    state: 'pending',
    createdAt: 1,
    revision: 1,
    dispatchGeneration: 0,
    dispatchAttempts: 0,
    ...overrides,
  };
}

describe('wake restore policy', () => {
  test('normalizes bounded conditions and payload selectors', () => {
    expect(normalizeWakeCondition({ all: ['a', 'b'] }, 2)).toMatchObject({
      condition: { all: ['a', 'b'] },
      references: ['a', 'b'],
    });
    expect(
      normalizeWakePayload({ payload: [{ kind: 'handoff', node: 'a@1' }] }, 1),
    ).toEqual([{ kind: 'handoff', node: 'a@1' }]);
    expect(() =>
      normalizeWakePayload({ payload: ['handoff', 'handoff'] }, 2),
    ).toThrow('Duplicate wake payload selectors are not allowed.');
  });

  test('requires the configured owner/session metadata and exact references', () => {
    const parsed = parseWakeRestoreSnapshot(
      {
        version: 1,
        ownerSessionId: 'owner',
        ownerEpoch: 2,
        wakes: [snapshot()],
      },
      options,
    );
    expect(parsed?.get('wake')).toMatchObject({
      ownerSessionId: 'owner',
      ownerEpoch: 2,
      references: ['done@1'],
    });
    expect(
      parseWakeRestoreSnapshot(
        {
          version: 1,
          ownerSessionId: 'other',
          ownerEpoch: 2,
          wakes: [snapshot()],
        },
        options,
      ),
    ).toBeUndefined();
    expect(
      parseWakeRestoreSnapshot(
        {
          version: 1,
          ownerSessionId: 'owner',
          ownerEpoch: 2,
          wakes: [snapshot({ references: ['done'] })],
        },
        options,
      ),
    ).toBeUndefined();
  });

  test('uses the current workflow lookup for old ready snapshots', () => {
    const parsed = parseWakeRestoreSnapshot(
      {
        version: 1,
        ownerSessionId: 'owner',
        ownerEpoch: 2,
        wakes: [snapshot({ state: 'ready', readyAt: 2 })],
      },
      options,
    );
    expect(parsed?.get('wake')?.readyReferences).toEqual(['done@1']);
  });

  test('merges without mutating inputs and enforces active capacity', () => {
    const record = parseWakeRestoreSnapshot(
      {
        version: 1,
        ownerSessionId: 'owner',
        ownerEpoch: 2,
        wakes: [snapshot()],
      },
      options,
    )?.get('wake');
    if (!record) throw new Error('missing parsed wake');
    const live = new Map([['wake', record]]);
    const newer = { ...record, revision: 2 } as WakeRestoreRecord;
    const incoming = new Map([['wake', newer]]);
    const merged = mergeWakeRestoreRecords(live, incoming, 4);
    expect(merged?.records.get('wake')).toBe(newer);
    expect(merged?.accepted).toEqual([newer]);
    expect(live.get('wake')).toBe(record);
    expect(incoming.get('wake')).toBe(newer);

    const second = { ...record, id: 'second' } as WakeRestoreRecord;
    expect(
      mergeWakeRestoreRecords(live, new Map([['second', second]]), 1),
    ).toBeUndefined();
  });

  test('detects missing and workflow-orphaned restore sources', () => {
    const record = parseWakeRestoreSnapshot(
      {
        version: 1,
        ownerSessionId: 'owner',
        ownerEpoch: 2,
        wakes: [snapshot()],
      },
      options,
    )?.get('wake');
    if (!record) throw new Error('missing parsed wake');
    expect(
      needsWakeReloadBlock(record, () => undefined, 'workflow orphan'),
    ).toBe(true);
    expect(
      needsWakeReloadBlock(
        record,
        options.currentWorkflowLookup,
        'workflow orphan',
      ),
    ).toBe(false);
    const current = options.currentWorkflowLookup('done@1');
    if (!current) throw new Error('missing current attempt');
    expect(
      needsWakeReloadBlock(
        record,
        () => ({ ...current, state: 'blocked', reason: 'workflow orphan' }),
        'workflow orphan',
      ),
    ).toBe(true);
  });
});
