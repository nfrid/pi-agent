import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defineExtension } from '../shared/runtime/extension';
import { registerTodoCommands } from './commands';
import { registerTodoContext } from './context';
import { clearTaskSurface, publishTaskSurface } from './live';
import { EXT } from './model';
import {
  createTaskStore,
  flushCompletedPendingHide,
  persist,
  reconstruct,
} from './store';
import { registerTodoTool } from './tool';
import { teardownUi, updateUi } from './widget';

export default defineExtension('tasks', (pi: ExtensionAPI) => {
  const store = createTaskStore();
  store.onChange = () => publishTaskSurface(store);

  pi.on('session_start', (_event, ctx) => {
    reconstruct(store, ctx);
    publishTaskSurface(store);
    updateUi(store, ctx);
  });
  pi.on('session_tree', (_event, ctx) => {
    reconstruct(store, ctx);
    publishTaskSurface(store);
    updateUi(store, ctx);
  });
  pi.on('session_compact', (_event, ctx) => {
    persist(store, pi);
    reconstruct(store, ctx);
    publishTaskSurface(store);
    updateUi(store, ctx);
  });
  pi.on('agent_start', (_event, ctx) => {
    if (flushCompletedPendingHide(store)) publishTaskSurface(store);
    updateUi(store, ctx);
  });
  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(EXT, undefined);
    teardownUi();
    clearTaskSurface();
    store.lastCtx = undefined;
  });

  registerTodoContext(pi, store);
  registerTodoTool(pi, store);
  registerTodoCommands(pi, store);
});
