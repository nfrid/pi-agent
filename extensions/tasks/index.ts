import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerTodoContext } from './context';
import { EXT } from './model';
import {
  createTaskStore,
  flushCompletedPendingHide,
  persist,
  reconstruct,
} from './store';
import { registerTodoTool } from './tool';
import { registerTodoCommands } from './ui';
import { updateUi } from './widget';

const registered = new WeakSet<object>();

export default function tasks(pi: ExtensionAPI) {
  if (registered.has(pi)) return;
  registered.add(pi);
  const store = createTaskStore();

  pi.on('session_start', (_event, ctx) => {
    reconstruct(store, ctx);
    updateUi(store, ctx);
  });
  pi.on('session_tree', (_event, ctx) => {
    reconstruct(store, ctx);
    updateUi(store, ctx);
  });
  pi.on('session_compact', (_event, ctx) => {
    persist(store, pi);
    reconstruct(store, ctx);
    updateUi(store, ctx);
  });
  pi.on('agent_start', (_event, ctx) => {
    flushCompletedPendingHide(store);
    updateUi(store, ctx);
  });
  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus(EXT, undefined);
      ctx.ui.setWidget(EXT, undefined);
    }
    store.lastCtx = undefined;
  });

  registerTodoContext(pi, store);
  registerTodoTool(pi, store);
  registerTodoCommands(pi, store);
}
