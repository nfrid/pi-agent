import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defineExtension } from '../shared/runtime/extension';
import {
  getSessionScopeId,
  type SessionScopeId,
} from '../shared/runtime/scoped-services';
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
  let scopeId: SessionScopeId = 'default';
  store.onChange = () => publishTaskSurface(store, scopeId);

  pi.on('session_start', (_event, ctx) => {
    const nextScope = getSessionScopeId(ctx);
    if (scopeId !== 'default' && scopeId !== nextScope)
      clearTaskSurface(scopeId);
    scopeId = nextScope;
    reconstruct(store, ctx);
    publishTaskSurface(store, scopeId);
    updateUi(store, ctx);
  });
  pi.on('session_tree', (_event, ctx) => {
    const nextScope = getSessionScopeId(ctx);
    if (scopeId !== 'default' && scopeId !== nextScope)
      clearTaskSurface(scopeId);
    scopeId = nextScope;
    reconstruct(store, ctx);
    publishTaskSurface(store, scopeId);
    updateUi(store, ctx);
  });
  pi.on('session_compact', (_event, ctx) => {
    scopeId = getSessionScopeId(ctx);
    persist(store, pi);
    reconstruct(store, ctx);
    publishTaskSurface(store, scopeId);
    updateUi(store, ctx);
  });
  pi.on('agent_start', (_event, ctx) => {
    if (flushCompletedPendingHide(store)) publishTaskSurface(store, scopeId);
    updateUi(store, ctx);
  });
  pi.on('session_shutdown', (_event, ctx) => {
    const closingScope = getSessionScopeId(ctx);
    if (scopeId !== closingScope) return;
    if (ctx.hasUI) ctx.ui.setStatus(EXT, undefined);
    teardownUi();
    clearTaskSurface(closingScope);
    store.lastCtx = undefined;
    if (scopeId === closingScope) scopeId = 'default';
  });

  registerTodoContext(pi, store);
  registerTodoTool(pi, store);
  registerTodoCommands(pi, store);
});
