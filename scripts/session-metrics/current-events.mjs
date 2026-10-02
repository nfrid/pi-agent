const TERMINAL_STATES = new Set(['success', 'error', 'timed-out', 'aborted']);

/** Fold current delegate journals and wake evidence in active-ancestry order. */
export function currentWorkflowAttempts(entries) {
  const attempts = new Map();
  const terminalObservations = new Map();
  const recordAttempt = (identity, attempt, index) => {
    let terminalIndex = attempts.get(identity)?.terminalIndex;
    if (TERMINAL_STATES.has(attempt.state)) {
      const observed = terminalObservations.get(identity);
      terminalIndex =
        observed?.state === attempt.state ? observed.index : index;
      terminalObservations.set(identity, {
        state: attempt.state,
        index: terminalIndex,
      });
    }
    attempts.set(identity, { attempt, index, terminalIndex });
  };

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.customType === 'delegate-workflow:v1') {
      const record = entry.data;
      if (
        record?.version !== 1 ||
        !['snapshot', 'delta'].includes(record.kind) ||
        record.state?.version !== 1 ||
        !Array.isArray(record.state.attempts)
      )
        continue;
      if (record.kind === 'snapshot') attempts.clear();
      for (const attempt of record.state.attempts)
        if (typeof attempt?.identity === 'string')
          recordAttempt(attempt.identity, attempt, index);
      continue;
    }
    if (entry.customType !== 'delegate-wake-result') continue;
    const sources = entry.details?.presentation?.sources;
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      if (
        typeof source?.identity !== 'string' ||
        !TERMINAL_STATES.has(source.state)
      )
        continue;
      const existing = attempts.get(source.identity);
      if (
        existing?.attempt.startedAt !== undefined &&
        TERMINAL_STATES.has(existing.attempt.state)
      )
        continue;
      recordAttempt(
        source.identity,
        {
          ...existing?.attempt,
          identity: source.identity,
          state: source.state,
          startedAt: existing?.attempt.startedAt ?? 0,
        },
        index,
      );
    }
  }
  return attempts;
}

export function isCurrentDelegateReceipt(message) {
  return (
    message?.isError !== true &&
    typeof message?.details?.workflow?.identity === 'string'
  );
}
