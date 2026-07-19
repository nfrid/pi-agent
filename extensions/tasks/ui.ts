import type {
  ExtensionAPI,
  ExtensionUIContext,
  Theme,
} from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import { findTask, missingDeps, stats } from './domain';
import { formatVisualTask, todoStateText } from './format';
import { MAX_RENDER_ITEMS, type Task, type TodoUiAction } from './model';
import { applyMutation } from './mutations';
import { pauseUiUpdates, resumeUiUpdates, type TaskStore } from './store';

class TodoOverlay {
  private selected = 0;
  private showCompleted = false;

  constructor(
    private readonly store: TaskStore,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: (action: TodoUiAction) => void,
  ) {}

  private visibleTasks(): Task[] {
    return this.store.state.tasks.filter(
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
    const s = stats(this.store);
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
      const waiting = missingDeps(this.store, task);
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

const TODO_OVERLAY_OPTIONS: NonNullable<
  Parameters<ExtensionUIContext['custom']>[1]
> = {
  overlay: true,
  overlayOptions: {
    width: '80%',
    minWidth: 60,
    maxHeight: '85%',
    anchor: 'right-center',
    margin: 1,
  },
};

export function registerTodoCommands(pi: ExtensionAPI, store: TaskStore): void {
  pi.registerCommand('todo', {
    description: 'Manage todos interactively',
    handler: async (_args, ctx) => {
      store.lastCtx = ctx;
      const mode = 'mode' in ctx ? ctx.mode : 'tui';
      if (mode !== 'tui') {
        if (ctx.hasUI) ctx.ui.notify(todoStateText(store), 'info');
        else console.log(todoStateText(store));
        return;
      }

      while (true) {
        let action: TodoUiAction | undefined;
        pauseUiUpdates(store);
        try {
          action = await ctx.ui.custom<TodoUiAction>(
            (tui, theme, _kb, done) =>
              new TodoOverlay(store, theme, () => tui.requestRender(), done),
            TODO_OVERLAY_OPTIONS,
          );
        } finally {
          resumeUiUpdates(store);
        }
        if (!action || action.kind === 'close') return;

        if (action.kind === 'add') {
          const text = await ctx.ui.input('Add todo', 'task text');
          if (text?.trim())
            applyMutation(store, pi, ctx, 'add', {
              action: 'add',
              text: text.trim(),
            });
        } else if (action.kind === 'edit') {
          const task = findTask(store, action.id);
          if (!task) continue;
          const text = await ctx.ui.input(`Edit ${task.id}`, task.text);
          if (text?.trim())
            applyMutation(store, pi, ctx, 'update', {
              action: 'update',
              id: task.id,
              text: text.trim(),
            });
        } else if (action.kind === 'notes') {
          const task = findTask(store, action.id);
          if (!task) continue;
          const notes = await ctx.ui.input(
            `Notes for ${task.id}`,
            task.notes ?? '',
          );
          if (notes !== undefined)
            applyMutation(store, pi, ctx, 'update', {
              action: 'update',
              id: task.id,
              notes: notes.trim() || undefined,
            });
        } else if (action.kind === 'deps') {
          const task = findTask(store, action.id);
          if (!task) continue;
          const deps = await ctx.ui.input(
            `Dependencies for ${task.id}`,
            task.dependsOn.join(','),
          );
          if (deps !== undefined) {
            const result = applyMutation(store, pi, ctx, 'update', {
              action: 'update',
              id: task.id,
              depends_on: deps.split(/[,\s]+/).filter(Boolean),
            });
            if (result.error) ctx.ui.notify(result.message, 'error');
          }
        } else if (action.kind === 'priority') {
          const task = findTask(store, action.id);
          if (!task) continue;
          const priority = await ctx.ui.select(`Priority for ${task.id}`, [
            'low',
            'normal',
            'high',
            'urgent',
          ]);
          if (priority)
            applyMutation(store, pi, ctx, 'update', {
              action: 'update',
              id: task.id,
              priority: priority as Task['priority'],
            });
        } else if (action.kind === 'status') {
          applyMutation(store, pi, ctx, 'update', {
            action: 'update',
            id: action.id,
            status: action.status,
          });
        } else if (action.kind === 'remove') {
          const ok = await ctx.ui.confirm(
            `Remove ${action.id}?`,
            'This removes the task permanently. Use drop/done if you want to keep history.',
          );
          if (ok) {
            const result = applyMutation(store, pi, ctx, 'remove', {
              action: 'remove',
              id: action.id,
            });
            if (result.error) ctx.ui.notify(result.message, 'error');
          }
        } else if (action.kind === 'clear_done') {
          const result = applyMutation(store, pi, ctx, 'clear_done', {
            action: 'clear_done',
          });
          ctx.ui.notify(result.message, 'info');
        }
      }
    },
  });

  pi.registerCommand('todump', {
    description: 'Insert current todo state into the editor',
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.setEditorText(todoStateText(store));
      else console.log(todoStateText(store));
    },
  });
}
