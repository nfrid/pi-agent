import { TIMEOUT_MS } from './constants';

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init.signal;
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('Usage request timed out.')),
    TIMEOUT_MS,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
  }
}
