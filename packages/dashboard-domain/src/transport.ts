export type TransportRejectReason =
  | 'old-cursor'
  | 'duplicate-runtime-seq'
  | 'old-runtime-epoch';

export interface TransportState {
  runtimeEpoch?: string;
  lastCursor: number;
  lastRuntimeSeq: number;
  /** Epochs which have been replaced; late frames from them are inert. */
  retiredEpochs: readonly string[];
}

export interface TransportRecord {
  cursor?: number;
  runtimeEpoch?: string;
  runtimeSeq?: number;
}

export interface TransportAcceptance {
  state: TransportState;
  accepted: boolean;
  reason?: TransportRejectReason;
  replacingEpoch: boolean;
}

/**
 * Apply the shared daemon transport ordering rules before a projection merge.
 * Epoch replacement resets sequence ordering and retires the previous epoch;
 * cursor and sequence rejection leave the supplied state untouched.
 */
export function applyTransportOrdering(
  current: TransportState,
  incoming: TransportRecord,
): TransportAcceptance {
  if (incoming.cursor !== undefined && incoming.cursor <= current.lastCursor)
    return {
      state: current,
      accepted: false,
      reason: 'old-cursor',
      replacingEpoch: false,
    };

  const epoch = incoming.runtimeEpoch;
  let runtimeEpoch = current.runtimeEpoch;
  let retiredEpochs = current.retiredEpochs;
  let replacingEpoch = false;
  // An untagged stream has no epoch-relative sequence baseline. The first
  // tagged epoch establishes one, even if untagged records advanced seq.
  const initializingEpoch =
    epoch !== undefined && current.runtimeEpoch === undefined;
  if (
    epoch !== undefined &&
    current.runtimeEpoch !== undefined &&
    epoch !== current.runtimeEpoch
  ) {
    if (current.retiredEpochs.includes(epoch))
      return {
        state: current,
        accepted: false,
        reason: 'old-runtime-epoch',
        replacingEpoch: false,
      };
    replacingEpoch = true;
    retiredEpochs = [...current.retiredEpochs, current.runtimeEpoch];
    runtimeEpoch = epoch;
  } else if (initializingEpoch) {
    runtimeEpoch = epoch;
  }

  if (
    !replacingEpoch &&
    epoch !== undefined &&
    current.retiredEpochs.includes(epoch)
  )
    return {
      state: current,
      accepted: false,
      reason: 'old-runtime-epoch',
      replacingEpoch: false,
    };
  if (
    !replacingEpoch &&
    !initializingEpoch &&
    incoming.runtimeSeq !== undefined &&
    incoming.runtimeSeq <= current.lastRuntimeSeq
  )
    return {
      state: current,
      accepted: false,
      reason: 'duplicate-runtime-seq',
      replacingEpoch: false,
    };

  return {
    state: {
      runtimeEpoch,
      retiredEpochs,
      lastCursor: incoming.cursor ?? current.lastCursor,
      lastRuntimeSeq:
        replacingEpoch || initializingEpoch
          ? (incoming.runtimeSeq ?? -1)
          : (incoming.runtimeSeq ?? current.lastRuntimeSeq),
    },
    accepted: true,
    replacingEpoch,
  };
}
