import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { EXT } from './constants';
import { normalizeId, normalizeIds } from './normalize';
import type { TaskStore } from './store';
import type { SnapshotEntry, State } from './types';

export const initialState = (): State => ({ version: 1, nextId: 1, tasks: [] });

export function cloneState(store: TaskStore): State {
  return JSON.parse(JSON.stringify(store.state)) as State;
}

export interface MutationSnapshot {
  state: State;
  completedPendingHide: Set<string>;
  hiddenCompleted: Set<string>;
}

export function captureMutationSnapshot(store: TaskStore): MutationSnapshot {
  return {
    state: cloneState(store),
    completedPendingHide: new Set(store.completedPendingHide),
    hiddenCompleted: new Set(store.hiddenCompleted),
  };
}

export function restoreMutationSnapshot(
  store: TaskStore,
  snapshot: MutationSnapshot,
): void {
  Object.assign(store.state, snapshot.state);
  store.completedPendingHide.clear();
  for (const id of snapshot.completedPendingHide)
    store.completedPendingHide.add(id);
  store.hiddenCompleted.clear();
  for (const id of snapshot.hiddenCompleted) store.hiddenCompleted.add(id);
}

export function applySnapshot(store: TaskStore, snapshot: State): void {
  Object.assign(store.state, {
    version: 1 as const,
    nextId: Math.max(1, snapshot.nextId || 1),
    tasks: (snapshot.tasks ?? []).map((task) => ({
      ...task,
      id: normalizeId(task.id) ?? task.id,
      dependsOn: normalizeIds(task.dependsOn),
      status: task.status ?? 'todo',
      createdAt: task.createdAt ?? Date.now(),
      updatedAt: task.updatedAt ?? Date.now(),
    })),
  });
  for (const task of store.state.tasks) {
    const match = /^T(\d+)$/.exec(task.id);
    if (match)
      store.state.nextId = Math.max(store.state.nextId, Number(match[1]) + 1);
  }
}

export function reconstruct(store: TaskStore, ctx: ExtensionContext): void {
  store.lastCtx = ctx;
  store.state = initialState();
  store.completedPendingHide = new Set();
  store.hiddenCompleted = new Set();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== EXT) continue;
    const data = entry.data as SnapshotEntry | undefined;
    if (data?.kind === 'snapshot' && data.state)
      applySnapshot(store, data.state);
  }
}

export function persist(store: TaskStore, pi: ExtensionAPI): void {
  pi.appendEntry(EXT, {
    kind: 'snapshot',
    state: cloneState(store),
  } satisfies SnapshotEntry);
}

export function forgetCompletedHide(
  store: TaskStore,
  ids?: Iterable<string>,
): void {
  if (!ids) {
    store.completedPendingHide = new Set();
    store.hiddenCompleted = new Set();
    return;
  }
  for (const id of ids) {
    store.completedPendingHide.delete(id);
    store.hiddenCompleted.delete(id);
  }
}

export function flushCompletedPendingHide(store: TaskStore): boolean {
  if (!store.completedPendingHide.size) return false;
  store.hiddenCompleted = new Set([
    ...store.hiddenCompleted,
    ...store.completedPendingHide,
  ]);
  store.completedPendingHide = new Set();
  return true;
}
