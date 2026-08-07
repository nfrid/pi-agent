import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type {
  QueueDraftMode,
  RuntimeLiveState,
  RuntimeSnapshot,
} from '../../packages/dashboard-protocol/src/pi-runtime-protocol';
import { getInteractionBroker } from '../ask-user/broker';
import { isGenuineAgentSettlement } from '../shared/runtime/agent-lifecycle';
import { liveExtensionSurfaceHub } from '../shared/runtime/live-surfaces';
import { BridgeClient } from './bridge-client';
import { dispatchDashboardCommand } from './command-dispatcher';
import { LiveEventNormalizer } from './live-event-normalizer';
import { isQueueDraftCommand, QueueDraftStore } from './queue-draft-store';
import {
  interactionSnapshot,
  liveState,
  modelCatalogSnapshot,
  modelSnapshot,
  RUNTIME_CAPABILITIES,
  sessionSnapshot,
  thinkingLevelsSnapshot,
} from './runtime-snapshot-adapter';

export interface RemoteControlRuntime {
  readonly runtimeId: string;
  readonly client: BridgeClient;
  readonly eventNormalizer: LiveEventNormalizer;
  readonly queueDrafts: QueueDraftStore;
  setContext(ctx: ExtensionContext): void;
  clearContext(ctx: ExtensionContext): void;
  isCurrent(ctx: ExtensionContext): boolean;
  setLiveState(state: RuntimeLiveState): void;
  snapshot(): RuntimeSnapshot;
}

export function createRemoteControlRuntime(
  pi: ExtensionAPI,
): RemoteControlRuntime | undefined {
  // This extension is globally loaded. A missing daemon is a normal offline
  // condition, not a reason to make Pi startup fail.
  const socketPath =
    process.env.PI_DASHBOARD_SOCKET ??
    path.join(os.homedir(), '.pi', 'agent', 'dashboard', 'bridge.sock');
  const runtimeId =
    process.env.PI_DASHBOARD_RUNTIME_ID || `runtime-${randomUUID()}`;
  const ownership = process.env.PI_DASHBOARD_RUNTIME_ID
    ? 'managed'
    : 'external';
  const broker = getInteractionBroker();
  const eventNormalizer = new LiveEventNormalizer();
  let context: ExtensionContext | undefined;
  let currentSessionId: string | undefined;
  let contextScope: string | undefined;
  let lastError: string | undefined;
  const queueDrafts = new QueueDraftStore();
  const unavailableSnapshot = (): RuntimeSnapshot => ({
    runtimeId,
    ownership,
    pid: process.pid,
    cwd: process.cwd(),
    liveState: 'idle',
    session: { id: 'unknown', entries: [] },
    pendingInteractions: broker.list().map(interactionSnapshot),
    queueDrafts: queueDrafts.list(),
    capabilities: RUNTIME_CAPABILITIES,
    extensionSurfaces: liveExtensionSurfaceHub.snapshot(),
    lastError,
  });
  let cachedSnapshot = unavailableSnapshot();
  const snapshotFrom = (ctx: ExtensionContext): RuntimeSnapshot => {
    const usage = ctx.getContextUsage();
    return {
      runtimeId,
      ownership,
      pid: process.pid,
      cwd: ctx.cwd,
      liveState: liveState(ctx, broker),
      session: sessionSnapshot(ctx),
      model: modelSnapshot(ctx),
      modelCatalog: modelCatalogSnapshot(ctx),
      thinkingLevels: thinkingLevelsSnapshot(),
      contextUsage: usage
        ? {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent,
          }
        : undefined,
      pendingInteractions: broker.list().map(interactionSnapshot),
      queueDrafts: queueDrafts.list(),
      capabilities: RUNTIME_CAPABILITIES,
      extensionSurfaces: liveExtensionSurfaceHub.snapshot(),
      lastError,
    };
  };
  const client = new BridgeClient({
    socketPath,
    token:
      process.env.PI_DASHBOARD_LAUNCH_TOKEN ?? process.env.PI_DASHBOARD_TOKEN,
    identityToken: process.env.PI_DASHBOARD_IDENTITY_TOKEN,
    runtimeId,
    broker,
    capabilities: RUNTIME_CAPABILITIES,
    commandScope: () => contextScope,
    liveSurfaces: liveExtensionSurfaceHub,
    onLiveSurfacesChanged: (surfaces) => {
      cachedSnapshot = { ...cachedSnapshot, extensionSurfaces: surfaces };
    },
    // Socket callbacks run outside Pi's extension event dispatch. Returning a
    // cache keeps reconnects from dereferencing a context that was invalidated
    // by session replacement or extension reload.
    snapshot: () => cachedSnapshot,
    handleCommand: async (command, capabilities) => {
      const commandContext = context;
      if (!commandContext) throw new Error('Pi session is not ready.');
      const commandSessionId = commandContext.sessionManager.getSessionId();
      const result = await dispatchDashboardCommand(
        pi,
        commandContext,
        broker,
        command,
        capabilities,
        queueDrafts,
      );
      // Queue mutations are dashboard-owned state, so acknowledge them only
      // after refreshing the cached snapshot. A session replacement that wins
      // the race must not publish the old draft set into the new session.
      if (
        isQueueDraftCommand(command) &&
        context === commandContext &&
        currentSessionId === commandSessionId
      ) {
        setContext(commandContext);
        client.sendEvent({
          type: 'runtime.stateChanged',
          state: liveState(commandContext, broker),
          snapshot: cachedSnapshot,
        });
      }
      return result;
    },
  });

  const setContext = (ctx: ExtensionContext) => {
    try {
      lastError = undefined;
      const nextScope = ctx.sessionManager.getSessionId();
      if (contextScope && contextScope !== nextScope) {
        broker.cancelScope(contextScope);
        eventNormalizer.reset();
      }
      queueDrafts.setSession(nextScope);
      const next = snapshotFrom(ctx);
      context = ctx;
      contextScope = nextScope;
      currentSessionId = next.session.id;
      cachedSnapshot = next;
    } catch (error) {
      queueDrafts.clear();
      if (contextScope) broker.cancelScope(contextScope);
      context = undefined;
      contextScope = undefined;
      currentSessionId = undefined;
      eventNormalizer.reset();
      lastError = error instanceof Error ? error.message : String(error);
      cachedSnapshot = unavailableSnapshot();
    }
  };
  const snapshot = () => cachedSnapshot;
  const setLiveState = (state: RuntimeLiveState) => {
    cachedSnapshot = { ...cachedSnapshot, liveState: state };
  };
  const isCurrent = (ctx: ExtensionContext) => {
    if (!currentSessionId) return false;
    try {
      return ctx.sessionManager.getSessionId() === currentSessionId;
    } catch {
      return false;
    }
  };
  const clearContext = (ctx: ExtensionContext) => {
    if (!isCurrent(ctx) && context !== ctx) return;
    try {
      broker.cancelScope(ctx.sessionManager.getSessionId());
    } catch {
      /* stale session contexts may no longer expose their manager */
    }
    if (contextScope) broker.cancelScope(contextScope);
    queueDrafts.setSession(undefined);
    queueDrafts.clear();
    context = undefined;
    contextScope = undefined;
    currentSessionId = undefined;
    eventNormalizer.reset();
    cachedSnapshot = unavailableSnapshot();
  };
  return {
    runtimeId,
    client,
    eventNormalizer,
    queueDrafts,
    setContext,
    clearContext,
    isCurrent,
    setLiveState,
    snapshot,
  };
}

export function flushQueueDrafts(
  runtime: RemoteControlRuntime,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  mode: QueueDraftMode,
): boolean {
  if (!runtime.isCurrent(ctx)) return false;
  runtime.setContext(ctx);
  if (!runtime.isCurrent(ctx)) return false;
  const drafts = runtime.queueDrafts.take(mode);
  if (drafts.length === 0) return false;
  let failedAt = drafts.length;
  for (const [index, draft] of drafts.entries()) {
    try {
      pi.sendUserMessage(draft.text, {
        deliverAs: draft.mode,
      });
    } catch {
      failedAt = index;
      break;
    }
  }
  // A send may synchronously trigger a session replacement. Never restore an
  // old session's drafts into the replacement, and never reinstall its cache.
  if (failedAt < drafts.length && runtime.isCurrent(ctx))
    runtime.queueDrafts.restore(drafts.slice(failedAt));
  if (runtime.isCurrent(ctx)) {
    runtime.setContext(ctx);
    if (runtime.isCurrent(ctx))
      runtime.client.sendEvent({
        type: 'runtime.stateChanged',
        state: liveState(ctx, getInteractionBroker()),
        snapshot: runtime.snapshot(),
      });
  }
  return true;
}

export function emitState(
  runtime: RemoteControlRuntime,
  ctx: ExtensionContext,
  forcedState?: RuntimeLiveState,
): void {
  if (!runtime.isCurrent(ctx)) return;
  runtime.setContext(ctx);
  if (!runtime.isCurrent(ctx)) return;
  const state = forcedState ?? liveState(ctx, getInteractionBroker());
  if (forcedState) runtime.setLiveState(forcedState);
  runtime.client.sendEvent({
    type: 'runtime.stateChanged',
    state,
    snapshot: runtime.snapshot(),
  });
}

export function emitAgentSettlement(
  runtime: RemoteControlRuntime,
  ctx: ExtensionContext,
): void {
  if (!isGenuineAgentSettlement()) {
    emitState(runtime, ctx, 'working');
    return;
  }
  emitState(runtime, ctx);
  if (!runtime.isCurrent(ctx)) return;
  runtime.client.sendEvent({
    type: 'agent.settled',
    sessionId: ctx.sessionManager.getSessionId(),
  });
}
