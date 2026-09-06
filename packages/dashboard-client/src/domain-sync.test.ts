import { describe, expect, it } from 'vitest';
import {
  acceptDomainCaughtUpOrdering,
  acceptDomainEventOrdering,
  acceptDomainSnapshotOrdering,
} from './domain-sync.js';

describe('domain synchronization ordering', () => {
  it('accepts only the next event after sequence is known', () => {
    const current = { generation: 3, sequence: 7, sequenceKnown: true };

    expect(acceptDomainEventOrdering(current, 8, 3)).toEqual({
      accepted: true,
    });
    expect(acceptDomainEventOrdering(current, 7, 3)).toEqual({
      accepted: false,
      reason: 'duplicate',
    });
    expect(acceptDomainEventOrdering(current, 9, 3)).toEqual({
      accepted: false,
      reason: 'gap',
    });
    expect(acceptDomainEventOrdering(current, 8, 4)).toEqual({
      accepted: false,
      reason: 'generation',
    });
  });

  it('rejects a shell event without an established baseline', () => {
    expect(
      acceptDomainEventOrdering(undefined, 1, 3, { unknownBaseline: 'reject' }),
    ).toEqual({ accepted: false, reason: 'baseline' });
    expect(acceptDomainEventOrdering(undefined, 1, 3)).toEqual({
      accepted: true,
    });
  });

  it('accepts an exact caught-up watermark and rebases an ahead one', () => {
    const current = { generation: 3, sequence: 7, sequenceKnown: true };

    expect(acceptDomainCaughtUpOrdering(current, 7, 3)).toEqual({
      accepted: true,
    });
    expect(acceptDomainCaughtUpOrdering(current, 6, 3)).toEqual({
      accepted: false,
      reason: 'duplicate',
    });
    expect(acceptDomainCaughtUpOrdering(current, 8, 3)).toEqual({
      accepted: false,
      reason: 'gap',
    });
    expect(acceptDomainCaughtUpOrdering(undefined, 8, 3)).toEqual({
      accepted: true,
    });
  });

  it('allows an authoritative snapshot to establish a lower sequence', () => {
    const current = { generation: 3, sequence: 7, sequenceKnown: true };

    expect(acceptDomainSnapshotOrdering(current, 6, 3)).toEqual({
      accepted: false,
      reason: 'duplicate',
    });
    expect(acceptDomainSnapshotOrdering(current, 6, 3, true)).toEqual({
      accepted: true,
    });
  });
});
