import { describe, expect, test } from 'vitest';
import {
  DELEGATE_RUNTIME_WARNING_ENTRY_TYPE,
  type DelegateRuntimeWarningRecord,
  foldDelegateRuntimeWarnings,
  formatDelegateRuntimeWarning,
} from './runtime-warning';

const pendingWarning: DelegateRuntimeWarningRecord = {
  version: 1,
  ownerBranchId: 'branch-owner',
  state: 'pending',
  warning: {
    identity: 'implementation@2',
    logicalId: 'implementation',
    route: 'luna-m',
    startedAt: 1_000,
    elapsedMs: 1_800_000,
    warningAfterMs: 1_800_000,
    status: 'warning',
  },
};

describe('delegate runtime warnings', () => {
  test('formats a neutral reminder that does not imply a stall or require cancellation', () => {
    expect(formatDelegateRuntimeWarning(pendingWarning.warning)).toBe(
      'Delegate runtime check\n\nDelegate implementation@2 (luna-m) has been running for 30 minutes and is still active. The runtime review threshold is 30 minutes; no automatic stop was applied. Inspect recent activity once if it would help decide whether to leave it running, send feedback, or cancel. A lack of visible activity alone does not establish a stall.',
    );
  });

  test('restores only the exact branch owner and keeps the latest one-shot state', () => {
    const entries = [
      {
        type: 'custom',
        customType: DELEGATE_RUNTIME_WARNING_ENTRY_TYPE,
        data: pendingWarning,
      },
      {
        type: 'custom',
        customType: DELEGATE_RUNTIME_WARNING_ENTRY_TYPE,
        data: { ...pendingWarning, ownerBranchId: 'sibling' },
      },
      {
        type: 'custom',
        customType: DELEGATE_RUNTIME_WARNING_ENTRY_TYPE,
        data: { ...pendingWarning, state: 'delivered' },
      },
    ];
    expect(
      foldDelegateRuntimeWarnings(entries, 'branch-owner').get(
        'implementation@2',
      ),
    ).toMatchObject({ state: 'delivered' });
    expect(
      foldDelegateRuntimeWarnings(entries, 'sibling').get('implementation@2'),
    ).toMatchObject({ ownerBranchId: 'sibling', state: 'pending' });
    expect(foldDelegateRuntimeWarnings(entries, 'other').size).toBe(0);
  });

  test('does not turn the warning into a wake, gate, or completion record', () => {
    expect(pendingWarning).not.toHaveProperty('condition');
    expect(pendingWarning).not.toHaveProperty('deliveryKey');
    expect(pendingWarning).not.toHaveProperty('completion');
  });
});
