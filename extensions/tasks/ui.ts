import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { todoStateText } from './format';
import type { TaskStore } from './store';
import { updateUi } from './widget';

export function registerTodoCommands(pi: ExtensionAPI, store: TaskStore): void {
  pi.registerCommand('todo', {
    description: 'Show the current todo state in the footer widget',
    handler: async (_args, ctx) => {
      store.lastCtx = ctx;
      updateUi(store, ctx);
      const text = todoStateText(store);
      if (ctx.hasUI) ctx.ui.notify(text, 'info');
      else console.log(text);
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
