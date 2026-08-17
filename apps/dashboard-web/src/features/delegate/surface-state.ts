export function surfaceText(value: string | undefined, fallback = ''): string {
  return value?.trim() || fallback;
}

export function surfaceStateLabel(value: string): string {
  const state = value.toLowerCase();
  if (state === 'running' || state === 'doing') return 'running';
  if (
    state === 'queued' ||
    state === 'todo' ||
    state === 'scheduled' ||
    state === 'pending' ||
    state === 'ready'
  )
    return 'queued';
  if (
    state === 'success' ||
    state === 'done' ||
    state === 'completed' ||
    state === 'entered'
  )
    return 'done';
  if (state === 'aborted') return 'aborted';
  if (state === 'dropped' || state === 'cancelled') return 'dropped';
  if (
    state === 'error' ||
    state === 'failed' ||
    state === 'blocked' ||
    state === 'timed-out'
  )
    return state === 'blocked' ? 'blocked' : 'failed';
  return state;
}

export function surfaceStateClass(state: string): string {
  if (state === 'paused') return 'surface-paused';
  if (state === 'pausing') return 'surface-pausing';
  if (state === 'running') return 'surface-running';
  if (state === 'done') return 'surface-done';
  if (state === 'failed' || state === 'blocked') return 'surface-failed';
  if (state === 'aborted') return 'surface-aborted';
  if (state === 'dropped') return 'surface-dropped';
  return 'surface-queued';
}

export function surfaceElapsed(
  start: unknown,
  finish: unknown,
  now = Date.now(),
): string | undefined {
  if (typeof start !== 'number') return undefined;
  const end = typeof finish === 'number' ? finish : now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
