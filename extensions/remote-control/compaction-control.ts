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

export async function cancelActiveCompaction(
  emitEscape: () => void = emitInteractiveEscape,
  timeoutMs = 500,
): Promise<void> {
  const signal = activeCompactionSignal;
  if (!signal || signal.aborted)
    throw new Error('There is no active context compaction to cancel.');
  const aborted = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
  });
  emitEscape();
  if (!(await aborted))
    throw new Error(
      'This Pi mode does not expose context compaction cancellation.',
    );
}
