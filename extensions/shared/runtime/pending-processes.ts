/**
 * Process-local aggregate of long-running work owned by independently loaded
 * extensions. The global symbol is required because Pi evaluates extension
 * entry points in isolated module graphs.
 */
interface PendingProcessState {
  readonly sources: Map<object, number>;
  total: number;
}

const pendingProcessesKey = Symbol.for('pi.pending-processes');
const pendingProcessesGlobal = globalThis as typeof globalThis & {
  [pendingProcessesKey]?: PendingProcessState;
};

function state(): PendingProcessState {
  const existing = pendingProcessesGlobal[pendingProcessesKey];
  if (existing) return existing;
  const created: PendingProcessState = { sources: new Map(), total: 0 };
  pendingProcessesGlobal[pendingProcessesKey] = created;
  return created;
}

/** Update one manager's contribution to the process-wide pending count. */
export function setPendingProcessCount(source: object, count: number): void {
  const pending = state();
  const previous = pending.sources.get(source) ?? 0;
  const next = Math.max(0, Math.floor(count));
  if (next === previous) return;
  if (next === 0) pending.sources.delete(source);
  else pending.sources.set(source, next);
  pending.total += next - previous;
}

export function pendingProcessCount(): number {
  return state().total;
}

export function hasPendingProcesses(): boolean {
  return pendingProcessCount() > 0;
}
