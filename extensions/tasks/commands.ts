import type {
  ExtensionAPI,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { todoStateText } from './format';
import { findTask } from './ids';
import { TodoOverlay } from './overlay';
import { pauseUiUpdates, resumeUiUpdates, type TaskStore } from './store';
import type { Task, TodoUiAction } from './types';
import { applyMutation } from './ui-widget';

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
