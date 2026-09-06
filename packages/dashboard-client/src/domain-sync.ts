/** Semantic synchronization status owned by DashboardLiveStore. */
export type DomainSyncStatus =
  | 'empty'
  | 'cached'
  | 'synchronizing'
  | 'live'
  | 'error';

/**
 * Accepted domain state. Connection lifecycle metadata is deliberately not
 * represented here; the store records only the semantic cut it accepted.
 */
export interface DomainSyncState {
  status: DomainSyncStatus;
  generation: number;
  sequence: number;
  sequenceKnown: boolean;
  error?: string;
}

export interface DomainOrderingState {
  generation: number;
  sequence: number;
  sequenceKnown: boolean;
}

export type DomainOrderingRejection =
  | 'generation'
  | 'duplicate'
  | 'gap'
  | 'baseline';

export interface DomainOrderingDecision {
  accepted: boolean;
  reason?: DomainOrderingRejection;
}

export interface DomainEventOrderingOptions {
  /** Shell feeds cannot apply an event until their snapshot establishes a cut. */
  unknownBaseline?: 'accept' | 'reject';
}

/** Decide whether a caught-up watermark is the current semantic cut. */
export function acceptDomainCaughtUpOrdering(
  current: DomainOrderingState | undefined,
  sequence: number,
  generation: number,
): DomainOrderingDecision {
  if (current && current.generation !== generation)
    return { accepted: false, reason: 'generation' };
  if (!current?.sequenceKnown) return { accepted: true };
  if (sequence < current.sequence)
    return { accepted: false, reason: 'duplicate' };
  if (sequence > current.sequence) return { accepted: false, reason: 'gap' };
  return { accepted: true };
}

/** Decide whether an authoritative snapshot may establish or replace a cut. */
export function acceptDomainSnapshotOrdering(
  current: DomainOrderingState | undefined,
  sequence: number,
  generation: number,
  authoritativeRebase = false,
): DomainOrderingDecision {
  if (current && current.generation !== generation)
    return { accepted: false, reason: 'generation' };
  if (
    current?.sequenceKnown === true &&
    !authoritativeRebase &&
    sequence <= current.sequence
  )
    return { accepted: false, reason: 'duplicate' };
  return { accepted: true };
}

/** Decide whether one contiguous semantic event may advance a domain cut. */
export function acceptDomainEventOrdering(
  current: DomainOrderingState | undefined,
  sequence: number,
  generation: number,
  options: DomainEventOrderingOptions = {},
): DomainOrderingDecision {
  if (current && current.generation !== generation)
    return { accepted: false, reason: 'generation' };
  if (!current?.sequenceKnown)
    return options.unknownBaseline === 'reject'
      ? { accepted: false, reason: 'baseline' }
      : { accepted: true };
  if (sequence <= current.sequence)
    return { accepted: false, reason: 'duplicate' };
  if (sequence !== current.sequence + 1)
    return { accepted: false, reason: 'gap' };
  return { accepted: true };
}
