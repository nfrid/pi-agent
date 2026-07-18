import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { EXT, MAX_WIDGET_LINES } from './constants';
import { mutate } from './core';
import { formatVisualTask } from './format';
import { stats } from './queries';
import {
  captureMutationSnapshot,
  persist,
  restoreMutationSnapshot,
} from './state';
import { type TaskStore, uiUpdatesPaused } from './store';
import type { Action, Params, Task } from './types';

function visibleWidgetTasks(store: TaskStore): Task[] {
  return store.state.tasks.filter(
    (task) =>
      task.status !== 'dropped' &&
      (task.status !== 'done' || !store.hiddenCompleted.has(task.id)),
  );
}

function markDisplayedCompleted(store: TaskStore, tasks: Task[]): void {
  for (const task of tasks) {
    if (task.status === 'done' && !store.hiddenCompleted.has(task.id))
      store.completedPendingHide.add(task.id);
  }
}

export function updateUi(store: TaskStore, ctx = store.lastCtx): void {
  if (uiUpdatesPaused(store) || !ctx?.hasUI) return;
  const s = stats(store);
  ctx.ui.setStatus(
    EXT,
    s.active
      ? ctx.ui.theme.fg('accent', `todo ${s.done}/${s.total}`)
      : undefined,
  );
  if (
    !s.active &&
    store.state.tasks.every(
      (task) => task.status !== 'done' || store.hiddenCompleted.has(task.id),
    )
  ) {
    ctx.ui.setWidget(EXT, undefined);
    return;
  }
  markDisplayedCompleted(store, visibleWidgetTasks(store));
  ctx.ui.setWidget(EXT, (_tui, theme) => ({
    invalidate() {},
    render(width: number): string[] {
      const tasks = visibleWidgetTasks(store);
      if (!tasks.length) return [];
      const current = stats(store);
      const headingIcon = current.active
        ? theme.fg('accent', '●')
        : theme.fg('dim', '○');
      const lines = [
        `${headingIcon} ${theme.fg(current.active ? 'accent' : 'dim', `Todos (${current.done}/${current.total})`)}`,
      ];
      const visible = tasks.slice(0, MAX_WIDGET_LINES - 1);
      visible.forEach((task, index) => {
        const prefix =
          index === visible.length - 1 && tasks.length === visible.length
            ? '└─'
            : '├─';
        lines.push(
          `${theme.fg('dim', prefix)} ${formatVisualTask(task, theme)}`,
        );
      });
      if (tasks.length > visible.length)
        lines.push(
          `${theme.fg('dim', '└─')} ${theme.fg('dim', `+${tasks.length - visible.length} more`)}`,
        );
      return lines.map((line) => truncateToWidth(line, width, '…'));
    },
  }));
}

export function applyMutation(
  store: TaskStore,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  action: Action,
  params: Params,
): { changed: boolean; message: string; error?: string } {
  const snapshot = captureMutationSnapshot(store);
  const result = mutate(store, action, params);
  try {
    updateUi(store, ctx);
    if (result.changed) persist(store, pi);
    return result;
  } catch (error) {
    restoreMutationSnapshot(store, snapshot);
    try {
      updateUi(store, ctx);
    } catch {
      // Preserve the original persistence/UI failure.
    }
    throw error;
  }
}
