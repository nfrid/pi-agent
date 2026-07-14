import type { Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import { MAX_RENDER_ITEMS } from './constants';
import { formatVisualTask } from './format';
import { missingDeps, stats } from './queries';
import { getState } from './state';
import type { Task, TodoUiAction } from './types';

export class TodoOverlay {
  private selected = 0;
  private showCompleted = false;

  constructor(
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: (action: TodoUiAction) => void,
  ) {}

  private visibleTasks(): Task[] {
    return getState().tasks.filter(
      (task) =>
        this.showCompleted ||
        (task.status !== 'dropped' && task.status !== 'done'),
    );
  }

  private selectedTask(): Task | undefined {
    const tasks = this.visibleTasks();
    if (this.selected >= tasks.length)
      this.selected = Math.max(0, tasks.length - 1);
    return tasks[this.selected];
  }

  handleInput(data: string): void {
    const tasks = this.visibleTasks();
    if (
      matchesKey(data, 'escape') ||
      matchesKey(data, 'ctrl+c') ||
      data === 'q'
    ) {
      this.done({ kind: 'close' });
      return;
    }
    if (matchesKey(data, 'up') || data === 'k')
      this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, 'down') || data === 'j')
      this.selected = Math.min(
        Math.max(0, tasks.length - 1),
        this.selected + 1,
      );
    else if (data === 'a') {
      this.done({ kind: 'add' });
      return;
    } else if (data === 'c') {
      this.done({ kind: 'clear_done' });
      return;
    } else if (data === 'h') this.showCompleted = !this.showCompleted;
    else {
      const task = this.selectedTask();
      if (!task) return;
      if (matchesKey(data, 'enter') || data === 'e') {
        this.done({ kind: 'edit', id: task.id });
        return;
      }
      if (data === 'n') {
        this.done({ kind: 'notes', id: task.id });
        return;
      }
      if (data === 'D') {
        this.done({ kind: 'deps', id: task.id });
        return;
      }
      if (data === 'd') {
        this.done({ kind: 'remove', id: task.id });
        return;
      }
      if (data === 'p') {
        this.done({ kind: 'priority', id: task.id });
        return;
      }
      if (data === 's') {
        this.done({ kind: 'status', id: task.id, status: 'doing' });
        return;
      }
      if (data === 'x') {
        this.done({ kind: 'status', id: task.id, status: 'done' });
        return;
      }
      if (data === 'b') {
        this.done({ kind: 'status', id: task.id, status: 'blocked' });
        return;
      }
    }
    this.requestRender();
  }

  render(width: number): string[] {
    const s = stats();
    const allTasks = this.visibleTasks();
    const tasks = allTasks.slice(0, MAX_RENDER_ITEMS);
    const lines = [
      `${this.theme.fg('accent', '●')} ${this.theme.fg('accent', this.theme.bold(`Todos (${s.done}/${s.total})`))}`,
      this.theme.fg(
        'dim',
        `${s.active} active • ${s.ready} ready • ${s.blocked} blocked • ↑↓/j/k select • enter/e edit • a add • s start • x done • b block • d remove • D deps • h ${this.showCompleted ? 'hide' : 'show'} completed • q close`,
      ),
      '',
    ];
    if (!tasks.length)
      lines.push(this.theme.fg('dim', 'No tasks. Press a to add one.'));
    tasks.forEach((task, index) => {
      const selected = index === this.selected;
      const marker = selected ? this.theme.fg('accent', '▶') : ' ';
      lines.push(
        `${marker} ${formatVisualTask(task, this.theme, { showNotes: true })}`,
      );
      const waiting = missingDeps(task);
      if (waiting.length)
        lines.push(
          `  ${this.theme.fg('dim', `waiting on ${waiting.join(', ')}`)}`,
        );
    });
    if (allTasks.length > tasks.length)
      lines.push(
        this.theme.fg('dim', `  +${allTasks.length - tasks.length} more`),
      );
    return lines.map((line) => truncateToWidth(line, width, '…'));
  }

  invalidate(): void {}
}
