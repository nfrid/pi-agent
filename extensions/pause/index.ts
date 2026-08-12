import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { defineExtension } from '../shared/runtime/extension';
import { getSessionScopeId } from '../shared/runtime/scoped-services';
import { clearPauseSurface, publishPauseSurface } from './live';
import {
  FOREGROUND_DELEGATES_PAUSED_EVENT,
  requestRuntimePause,
  resumeRuntimePause,
} from './operations';
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
  const activeTools = new Map<string, { scopeId: string; toolName: string }>();
  const foregroundPausedGenerations = new Map<string, number>();

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

  const markQuiescentForegroundBoundary = (ctx: {
    sessionManager: { getSessionId(): string };
  }) => {
    const coordinator = getPauseCoordinator(getSessionScopeId(ctx));
    const snapshot = coordinator.snapshot();
    if (
      !snapshot ||
      foregroundPausedGenerations.get(getSessionScopeId(ctx)) !==
        snapshot.generation ||
      [...activeTools.values()].some(
        (tool) =>
          tool.scopeId === getSessionScopeId(ctx) &&
          tool.toolName !== 'delegate',
      )
    )
      return;
    coordinator.markMainReached(snapshot.generation);
  };

  pi.on('tool_execution_start', (event, ctx) => {
    const toolScopeId = getSessionScopeId(ctx);
    activeTools.set(event.toolCallId, {
      scopeId: toolScopeId,
      toolName: event.toolName,
    });
    if (event.toolName === 'delegate') return;
    const coordinator = getPauseCoordinator(toolScopeId);
    const snapshot = coordinator.snapshot();
    if (
      snapshot &&
      snapshot.generation === foregroundPausedGenerations.get(toolScopeId)
    )
      coordinator.markMainUnreached(snapshot.generation);
  });
  pi.on('tool_execution_end', (event, ctx) => {
    const eventScopeId = getSessionScopeId(ctx);
    const active = activeTools.get(event.toolCallId);
    if (active?.scopeId === eventScopeId) activeTools.delete(event.toolCallId);
    markQuiescentForegroundBoundary(ctx);
  });
  pi.events.on(FOREGROUND_DELEGATES_PAUSED_EVENT, (value) => {
    const event = value as { scopeId: string; generation: number };
    if (event.scopeId !== scopeId) return;
    foregroundPausedGenerations.set(event.scopeId, event.generation);
    if (!scopeId) return;
    const coordinator = getPauseCoordinator(scopeId);
    const snapshot = coordinator.snapshot();
    if (
      snapshot?.generation === event.generation &&
      ![...activeTools.values()].some(
        (tool) =>
          tool.scopeId === event.scopeId && tool.toolName !== 'delegate',
      )
    )
      coordinator.markMainReached(event.generation);
  });

  pi.on('context', async (_event, ctx) => gate(ctx));
  pi.on('before_provider_request', async (_event, ctx) => gate(ctx));
  // turn_end follows finalized, persisted tool-result messages. A pause issued
  // during a tool (including synchronous delegation) must enter the main gate
  // here even when no subsequent provider request is started.
  pi.on('turn_end', async (_event, ctx) => gate(ctx));
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
    for (const [toolCallId, tool] of activeTools)
      if (tool.scopeId === closingScope) activeTools.delete(toolCallId);
    foregroundPausedGenerations.delete(closingScope);
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
