import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { State } from './types';

export type TaskStore = {
  state: State;
  lastCtx: ExtensionContext | undefined;
  completedPendingHide: Set<string>;
  hiddenCompleted: Set<string>;
  uiPauseDepth: number;
};

const STORE_KEY = '__piAgentTasksStore';

export function getTaskStore(): TaskStore {
  const global = globalThis as typeof globalThis & {
    [STORE_KEY]?: TaskStore;
  };
  if (!global[STORE_KEY]) {
    global[STORE_KEY] = {
      state: { version: 1, nextId: 1, tasks: [] },
      lastCtx: undefined,
      completedPendingHide: new Set(),
      hiddenCompleted: new Set(),
      uiPauseDepth: 0,
    };
  }
  return global[STORE_KEY];
}

export function pauseUiUpdates(): void {
  getTaskStore().uiPauseDepth++;
}

export function resumeUiUpdates(): void {
  getTaskStore().uiPauseDepth = Math.max(0, getTaskStore().uiPauseDepth - 1);
}

export function uiUpdatesPaused(): boolean {
  return getTaskStore().uiPauseDepth > 0;
}
