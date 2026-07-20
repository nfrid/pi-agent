let activeRuns = 0;
const slotWaiters: Array<() => void> = [];
const sessionTails = new Map<string, Promise<void>>();

export async function acquireSession(sessionPath: string): Promise<() => void> {
  const previous = sessionTails.get(sessionPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionTails.set(sessionPath, current);
  await previous;
  return () => {
    release();
    if (sessionTails.get(sessionPath) === current)
      sessionTails.delete(sessionPath);
  };
}

export async function acquireSlot(
  signal?: AbortSignal,
  maxConcurrency = 5,
): Promise<() => void> {
  if (signal?.aborted)
    throw new Error('Delegated task was aborted before launch.');
  if (activeRuns < maxConcurrency) activeRuns++;
  else {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = slotWaiters.indexOf(onReady);
        if (index >= 0) slotWaiters.splice(index, 1);
        reject(new Error('Delegated task was aborted before launch.'));
      };
      const onReady = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      slotWaiters.push(onReady);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = slotWaiters.shift();
    if (next) next();
    else activeRuns--;
  };
}

export async function mapWithConcurrency<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  const results = new Array<TOut>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const workers = new Array(Math.max(1, Math.min(concurrency, items.length)))
    .fill(null)
    .map(async () => {
      while (!failed) {
        const index = next++;
        if (index >= items.length) return;
        try {
          results[index] = await fn(items[index], index);
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      }
    });
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}
