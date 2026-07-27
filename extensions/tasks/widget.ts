import { truncateToWidth } from '@earendil-works/pi-tui';
import { createRailPanel } from '../shared/ui/rail';
import { stats } from './domain';
import { formatVisualTask } from './format';
import { EXT, MAX_WIDGET_LINES, type Task } from './model';
import type { TaskStore } from './store';

/** Below this the todo rows are unreadable, so the rail stacks instead. */
const TODO_WIDGET_MIN_WIDTH = 28;

function completedTaskVisible(store: TaskStore, task: Task): boolean {
  return task.status === 'done' && !store.hiddenCompleted.has(task.id);
}

function visibleWidgetTasks(store: TaskStore): Task[] {
  return store.state.tasks.filter(
    (task) =>
      task.status !== 'dropped' &&
      (task.status !== 'done' || completedTaskVisible(store, task)),
  );
}

function markDisplayedCompleted(store: TaskStore, tasks: Task[]): void {
  for (const task of tasks) {
    if (completedTaskVisible(store, task))
      store.completedPendingHide.add(task.id);
  }
}

function hasWidgetContent(store: TaskStore): boolean {
  return (
    stats(store).active > 0 ||
    store.state.tasks.some((task) => completedTaskVisible(store, task))
  );
}

/**
 * The rail renders on its own schedule, so the panel reads whichever store the
 * live session last handed it rather than closing over one.
 */
let panelStore: TaskStore | undefined;
let attachedUi: unknown;

const panel = createRailPanel({
  key: EXT,
  side: 'left',
  order: 0,
  minWidth: TODO_WIDGET_MIN_WIDTH,
  isActive: () => Boolean(panelStore && hasWidgetContent(panelStore)),
  render(width, theme) {
    const store = panelStore;
    if (!store) return [];
    const tasks = visibleWidgetTasks(store);
    if (!tasks.length) return [];
    const current = stats(store);
    const headingIcon =
      current.active > 0 ? theme.fg('accent', '●') : theme.fg('dim', '○');
    const lines = [
      `${headingIcon} ${theme.fg(current.active > 0 ? 'accent' : 'dim', `Todos (${current.done}/${current.total})`)}`,
    ];
    const visible = tasks.slice(0, MAX_WIDGET_LINES - 1);
    visible.forEach((task, index) => {
      const prefix =
        index === visible.length - 1 && tasks.length === visible.length
          ? '└─'
          : '├─';
      lines.push(`${theme.fg('dim', prefix)} ${formatVisualTask(task, theme)}`);
    });
    if (tasks.length > visible.length)
      lines.push(
        `${theme.fg('dim', '└─')} ${theme.fg('dim', `+${tasks.length - visible.length} more`)}`,
      );
    return lines.map((line) => truncateToWidth(line, width, '…'));
  },
});

export function updateUi(store: TaskStore, ctx = store.lastCtx): void {
  if (!ctx?.hasUI) return;
  const s = stats(store);
  ctx.ui.setStatus(
    EXT,
    s.active
      ? ctx.ui.theme.fg('accent', `todo ${s.done}/${s.total}`)
      : undefined,
  );
  panelStore = store;
  markDisplayedCompleted(store, visibleWidgetTasks(store));
  // Re-attaching remounts the rail, so only do it when the session's UI is new.
  if (attachedUi !== ctx.ui) {
    attachedUi = ctx.ui;
    panel.attach(ctx.ui);
  }
  panel.sync();
}

export function teardownUi(): void {
  panelStore = undefined;
  attachedUi = undefined;
  panel.detach();
}
