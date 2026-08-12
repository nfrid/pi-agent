import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { defineExtension } from '../shared/runtime/extension';
import { getSessionScopeId } from '../shared/runtime/scoped-services';
import { clearPauseSurface, publishPauseSurface } from './live';
import { requestRuntimePause, resumeRuntimePause } from './operations';
import { registerPauseCapability } from './register-capability';
import {
  getPauseCoordinator,
  pauseLabel,
  releasePauseCoordinator,
} from './state';

export default defineExtension('pause', (pi: ExtensionAPI) => {
  registerPauseCapability();
  let scopeId: string | undefined;
  let unsubscribe: (() => void) | undefined;

  const bind = (ctx: ExtensionContext) => {
    unsubscribe?.();
    scopeId = getSessionScopeId(ctx);
    const boundScope = scopeId;
    const coordinator = getPauseCoordinator(boundScope);
    unsubscribe = coordinator.subscribe((snapshot) => {
      if (!snapshot) {
        if (ctx.hasUI) {
          ctx.ui.setStatus('runtime-pause', undefined);
          ctx.ui.setWorkingIndicator?.();
        }
        clearPauseSurface(boundScope);
        return;
      }
      const label =
        snapshot.phase === 'paused' ? pauseLabel(snapshot) : 'Pausing…';
      if (ctx.hasUI) {
        ctx.ui.setStatus('runtime-pause', label);
        ctx.ui.setWorkingIndicator?.({ frames: ['•'] });
      }
      publishPauseSurface(snapshot, boundScope);
    });
  };

  pi.on('session_start', (_event, ctx) => bind(ctx));

  pi.registerCommand('pause', {
    description: 'Pause the main agent and active delegates at safe boundaries',
    handler: async (_args, ctx) => {
      const snapshot = requestRuntimePause(pi, ctx);
      if (ctx.hasUI && snapshot.phase === 'pausing')
        ctx.ui.notify('Pause requested; finishing the current turn.', 'info');
    },
  });

  const gate = async (ctx: { sessionManager: { getSessionId(): string } }) => {
    const coordinator = getPauseCoordinator(getSessionScopeId(ctx));
    const snapshot = coordinator.snapshot();
    if (snapshot) await coordinator.waitForResume(snapshot.generation);
  };

  pi.on('context', async (_event, ctx) => gate(ctx));
  pi.on('before_provider_request', async (_event, ctx) => gate(ctx));
  pi.on('agent_settled', (_event, ctx) => {
    const coordinator = getPauseCoordinator(getSessionScopeId(ctx));
    const snapshot = coordinator.snapshot();
    if (snapshot) coordinator.markMainReached(snapshot.generation);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    const closingScope = getSessionScopeId(ctx);
    resumeRuntimePause(pi, ctx);
    clearPauseSurface(closingScope);
    releasePauseCoordinator(closingScope);
    if (scopeId !== closingScope) return;
    unsubscribe?.();
    unsubscribe = undefined;
    if (ctx.hasUI) {
      ctx.ui.setStatus('runtime-pause', undefined);
      ctx.ui.setWorkingIndicator?.();
    }
    scopeId = undefined;
  });
});
