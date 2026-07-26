/**
 * One implementation of abort propagation and bounded waiting.
 *
 * Every helper here treats `signal.reason` as authoritative when it is already
 * an Error, so a caller-supplied cancellation cause survives untouched through
 * nested awaits. Only when the reason is absent or non-Error is a substitute
 * created, and that substitute is a DOMException named `AbortError` unless the
 * caller supplies its own message.
 */

/** Resolve the error a cancelled operation should reject with. */
export function abortError(
  signal: AbortSignal,
  fallbackMessage?: string,
): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return fallbackMessage === undefined
    ? new DOMException('Aborted', 'AbortError')
    : new Error(fallbackMessage);
}

/** Throw if the signal is already aborted; a no-op for an absent signal. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortError(signal);
}

/**
 * Await `promise` for at most `timeoutMs`, resolving early on timeout rather
 * than failing. A timeout is not an error here: callers use this to bound how
 * long they observe work that legitimately continues afterwards.
 */
export function waitFor(
  promise: Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (timeoutMs <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const onAbort = () => finish(abortError(signal as AbortSignal));
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      () => finish(),
      (error: unknown) => finish(error),
    );
  });
}

/**
 * Reject as soon as `signal` aborts, without waiting for `promise` to settle.
 * The underlying work is not cancelled; only the caller stops observing it.
 */
export function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Sleep for `ms`, rejecting immediately if the signal aborts first. */
export async function abortableDelay(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(abortError(signal as AbortSignal));
    };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
