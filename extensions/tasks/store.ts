import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { State } from './types';

export type TaskStore = {
  state: State;
  lastCtx: ExtensionContext | undefined;
  completedPendingHide: Set<string>;
  hiddenCompleted: Set<string>;
  uiPauseDepth: number;
};

/** Runtime state owned by one task extension registration. */
export function createTaskStore(): TaskStore {
  return {
    state: { version: 1, nextId: 1, tasks: [] },
    lastCtx: undefined,
    completedPendingHide: new Set(),
    hiddenCompleted: new Set(),
    uiPauseDepth: 0,
  };
}

export function pauseUiUpdates(store: TaskStore): void {
  store.uiPauseDepth++;
}

export function resumeUiUpdates(store: TaskStore): void {
  store.uiPauseDepth = Math.max(0, store.uiPauseDepth - 1);
}

export function uiUpdatesPaused(store: TaskStore): boolean {
  return store.uiPauseDepth > 0;
}
