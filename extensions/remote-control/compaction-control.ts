let activeCompactionSignal: AbortSignal | undefined;

function emitInteractiveEscape(): void {
  process.stdin.emit('data', '\u001b');
}

export function trackActiveCompaction(signal: AbortSignal): void {
  activeCompactionSignal = signal;
  signal.addEventListener(
    'abort',
    () => {
      if (activeCompactionSignal === signal) activeCompactionSignal = undefined;
    },
    { once: true },
  );
}

export function clearActiveCompaction(signal?: AbortSignal): void {
  if (signal === undefined || activeCompactionSignal === signal)
    activeCompactionSignal = undefined;
}

export function cancelActiveCompaction(
  emitEscape: () => void = emitInteractiveEscape,
): void {
  const signal = activeCompactionSignal;
  if (!signal || signal.aborted)
    throw new Error('There is no active context compaction to cancel.');
  emitEscape();
  if (!signal.aborted)
    throw new Error(
      'This Pi mode does not expose context compaction cancellation.',
    );
}
