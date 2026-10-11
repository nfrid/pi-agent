import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  type BridgeEvent,
  MAX_ID,
  type QueueDraftMode,
  type RuntimeLiveState,
  type RuntimeSnapshot,
  type RuntimeSnapshotPatch,
} from '@pi-dashboard/protocol/pi-runtime-protocol';
import { isGenuineAgentSettlement } from '../shared/runtime/agent-lifecycle';
import { getNativeSteeringController } from '../shared/runtime/native-steering';
import { pendingProcessCount } from '../shared/runtime/pending-processes';
import {
  findScopedServices,
  getScopedServices,
  releaseScopedServices,
  type ScopedServices,
  type SessionScopeId,
} from '../shared/runtime/scoped-services';
import { recordHarnessFailure } from '../shared/telemetry';
import { BridgeClient } from './bridge-client';
import { expandDashboardInput } from './command-adapter';
import { dispatchDashboardCommand } from './command-dispatcher';
import {
  clearQueueSendObservations,
  type QueueSendSettlement,
  withQueueSendObservation,
} from './external-delivery';
import { clearSettledBackground, publishSettledBackground } from './live';
import { LiveEventNormalizer } from './live-event-normalizer';
import { nativeSteeringContribution } from './native-steering';
import {
  isQueueDraftCommand,
  QueueDraftStore,
  type StoredQueueDraft,
} from './queue-draft-store';
import { registerRemoteControlCapability } from './register-capability';
import {
  composerCommandsSnapshot,
  getRuntimeCapabilities,
  liveState,
  modelCatalogSnapshot,
  modelSnapshot,
  sessionSnapshot,
  thinkingLevelsSnapshot,
} from './runtime-snapshot-adapter';

export interface RemoteControlRuntime {
  readonly runtimeId: string;
  readonly client: BridgeClient;
  readonly eventNormalizer: LiveEventNormalizer;
  readonly queueDrafts: QueueDraftStore;
  setContext(ctx: ExtensionContext, refreshSnapshot?: boolean): void;
  clearContext(ctx: ExtensionContext): void;
  isCurrent(ctx: ExtensionContext): boolean;
  setLiveState(state: RuntimeLiveState): void;
  /** Build a bounded runtime update without reading the session branch. */
  snapshotPatch?(
    ctx: ExtensionContext,
    state?: RuntimeLiveState,
    contextTokens?: number,
  ): RuntimeSnapshotPatch;
  snapshot(): RuntimeSnapshot;
}

export function createRemoteControlRuntime(
  pi: ExtensionAPI,
): RemoteControlRuntime | undefined {
  registerRemoteControlCapability();
  // This extension is globally loaded. A missing daemon is a normal offline
  // condition, not a reason to make Pi startup fail.
  const socketPath =
    process.env.PI_DASHBOARD_SOCKET ??
    path.join(os.homedir(), '.pi', 'agent', 'dashboard', 'bridge.sock');
  const managedRuntimeId = process.env.PI_DASHBOARD_RUNTIME_ID?.trim();
  const externalRuntimeId =
    process.env.PI_DASHBOARD_EXTERNAL_RUNTIME_ID?.trim();
  const runtimeId =
    managedRuntimeId || externalRuntimeId || `runtime-${randomUUID()}`;
  const ownership = managedRuntimeId ? 'managed' : 'external';
  let scopedServices: ScopedServices = getScopedServices();
  let liveSurfaceHub = scopedServices.liveSurfaceHub;
  const eventNormalizer = new LiveEventNormalizer();
  let context: ExtensionContext | undefined;
  let currentSessionId: string | undefined;
  let contextGeneration = 0;
  let contextScope: SessionScopeId | undefined;
  let lastError: string | undefined;
  const queueDrafts = new QueueDraftStore();
  const capabilitiesFor = (services = scopedServices) =>
    getRuntimeCapabilities(services.scopeId);
  const unavailableSnapshot = (): RuntimeSnapshot => ({
    runtimeId,
    ownership,
    pid: process.pid,
    cwd: process.cwd(),
    liveState: 'idle',
    session: { id: 'unknown', entries: [] },
    queueDrafts: queueDrafts.list(),
    composerCommands: composerCommandsSnapshot(pi),
    capabilities: capabilitiesFor(),
    extensionSurfaces: liveSurfaceHub.snapshot(),
    lastError,
  });
  let cachedSnapshot = unavailableSnapshot();
  const runtimePatchFrom = (
    ctx: ExtensionContext,
    state = liveState(ctx),
    contextTokens?: number,
    services = scopedServices,
  ): RuntimeSnapshotPatch => {
    const currentUsage = ctx.getContextUsage();
    const contextWindow =
      currentUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const usage =
      contextTokens === undefined
        ? currentUsage
        : {
            tokens: contextTokens,
            contextWindow,
            percent: contextWindow
              ? (contextTokens / contextWindow) * 100
              : null,
          };
    const sessionId = ctx.sessionManager.getSessionId();
    const currentLeafId = ctx.sessionManager.getLeafId();
    const leafId =
      typeof currentLeafId === 'string' &&
      currentLeafId.length > 0 &&
      currentLeafId.length <= MAX_ID &&
      !Array.from(currentLeafId).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      })
        ? currentLeafId
        : undefined;
    const cachedSession = cachedSnapshot.session;
    // A routine update must invalidate the cached branch for both reconnect
    // hello and the daemon's runtime-backed session read. Metadata is retained,
    // while only the current context leaf may select the persisted branch.
    const session = {
      id: sessionId,
      ...(cachedSession.id === sessionId && cachedSession.file !== undefined
        ? { file: cachedSession.file }
        : {}),
      ...(cachedSession.id === sessionId && cachedSession.name !== undefined
        ? { name: cachedSession.name }
        : {}),
      ...(cachedSession.id === sessionId && cachedSession.title !== undefined
        ? { title: cachedSession.title }
        : {}),
      cwd:
        cachedSession.id === sessionId
          ? (cachedSession.cwd ?? ctx.cwd)
          : ctx.cwd,
      ...(leafId === undefined ? {} : { leafId }),
      entries: [],
      entriesComplete: false,
    };
    return {
      cwd: ctx.cwd,
      liveState: state,
      online: true,
      lastSeenAt: Date.now(),
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
      queueDrafts:
        queueDrafts.getSessionId() === sessionId ? queueDrafts.list() : [],
      queueHandoffs:
        queueDrafts.getSessionId() === sessionId
          ? queueDrafts.listHandoffs()
          : [],
      composerCommands: composerCommandsSnapshot(pi),
      capabilities: capabilitiesFor(services),
      extensionSurfaces: services.liveSurfaceHub.snapshot(),
      lastError,
      session,
    };
  };
  const snapshotFrom = (
    ctx: ExtensionContext,
    services = scopedServices,
  ): RuntimeSnapshot => {
    const patch = runtimePatchFrom(ctx, undefined, undefined, services);
    return {
      runtimeId,
      ownership,
      pid: process.pid,
      ...patch,
      cwd: ctx.cwd,
      liveState: liveState(ctx),
      session: sessionSnapshot(ctx),
    };
  };
  const client = new BridgeClient({
    socketPath,
    token:
      process.env.PI_DASHBOARD_LAUNCH_TOKEN ?? process.env.PI_DASHBOARD_TOKEN,
    identityToken: process.env.PI_DASHBOARD_IDENTITY_TOKEN,
    runtimeId,
    commandScope: () => contextScope,
    liveSurfaces: liveSurfaceHub,
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
        command,
        capabilities,
        queueDrafts,
      );
      // Queue edits and idle aborts need a fresh snapshot even when the SDK
      // emits no new run event. Never publish an old session's state.
      if (
        (isQueueDraftCommand(command) || command.type === 'abort') &&
        context === commandContext &&
        currentSessionId === commandSessionId
      ) {
        if (command.type === 'abort') clearSettledBackground(commandSessionId);
        setContext(commandContext, false);
        const state = liveState(commandContext);
        client.sendEvent({
          type: 'runtime.stateChanged',
          state,
          snapshot: snapshotPatch(commandContext, state),
        });
      }
      return result;
    },
  });

  const usageBroker = {
    read: (force: boolean, signal?: AbortSignal) =>
      client.requestUsage(force, signal),
  };

  const setContext = (ctx: ExtensionContext, refreshSnapshot = true) => {
    const previousServices = scopedServices;
    const previousScope = contextScope;
    let nextServices: ScopedServices | undefined;
    let nextServicesWasCreated = false;
    let attemptedBinding = false;
    try {
      lastError = undefined;
      const nextScope = ctx.sessionManager.getSessionId();
      const existingServices = findScopedServices(nextScope);
      nextServices = existingServices ?? getScopedServices(nextScope);
      nextServicesWasCreated = existingServices === undefined;
      const replacingScope =
        previousScope !== undefined && previousScope !== nextScope;
      // Build the replacement completely before publishing it. In particular,
      // snapshot failures must not destroy the still-current generation.
      const shouldRefresh =
        refreshSnapshot || previousScope === undefined || replacingScope;
      const next = shouldRefresh ? snapshotFrom(ctx, nextServices) : undefined;
      if (replacingScope) {
        if (previousScope) clearQueueSendObservations(previousScope);
        eventNormalizer.reset();
      }
      attemptedBinding = nextServices !== previousServices;
      if (attemptedBinding) client.bindServices(nextServices.liveSurfaceHub);
      nextServices.dashboardUsage = usageBroker;
      scopedServices = nextServices;
      liveSurfaceHub = nextServices.liveSurfaceHub;
      if (replacingScope && previousScope)
        releaseScopedServices(previousScope, previousServices);
      queueDrafts.setSession(nextScope);
      if (currentSessionId !== nextScope) contextGeneration++;
      context = ctx;
      contextScope = nextScope;
      currentSessionId = nextScope;
      const bindingGeneration = contextGeneration;
      nextServices.capabilities.register(
        nativeSteeringContribution({
          getContext: () => context,
          pi,
          store: queueDrafts,
          isCurrent: (candidate) =>
            bindingGeneration === contextGeneration && isCurrent(candidate),
          publish: (candidate) => {
            const active = context;
            if (!active || !isCurrent(candidate) || !isCurrent(active)) return;
            setContext(active, false);
            const state = liveState(active);
            client.sendEvent({
              type: 'runtime.stateChanged',
              state,
              snapshot: snapshotPatch(active, state),
            });
          },
        }),
      );
      if (next)
        cachedSnapshot = {
          ...next,
          capabilities: getRuntimeCapabilities(nextScope),
        };
    } catch (error) {
      if (attemptedBinding) {
        try {
          client.bindServices(previousServices.liveSurfaceHub);
        } catch {
          // The bridge is best-effort; retain the old runtime ownership even if
          // an observer cannot be rebound during rollback.
        }
      }
      if (nextServices && nextServicesWasCreated)
        releaseScopedServices(nextServices.scopeId, nextServices);
      recordHarnessFailure('remote-control', 'snapshot-binding-failed', error);
      lastError = error instanceof Error ? error.message : String(error);
      if (!context) {
        queueDrafts.clear();
        eventNormalizer.reset();
        cachedSnapshot = unavailableSnapshot();
      }
    }
  };
  const snapshotPatch = (
    ctx: ExtensionContext,
    state?: RuntimeLiveState,
    contextTokens?: number,
  ): RuntimeSnapshotPatch => {
    const patch = runtimePatchFrom(ctx, state, contextTokens);
    // Keep reconnect/hello authoritative while replacing any cached transcript
    // branch with the bounded invalidation session metadata.
    cachedSnapshot = { ...cachedSnapshot, ...patch };
    return patch;
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
    const closingServices = scopedServices;
    const closingScope = contextScope;
    closingServices.capabilities.unregister('remote-control.native-steering');
    if (closingScope) clearQueueSendObservations(closingScope);
    contextGeneration++;
    queueDrafts.setSession(undefined);
    queueDrafts.clear();
    context = undefined;
    contextScope = undefined;
    currentSessionId = undefined;
    scopedServices = getScopedServices();
    liveSurfaceHub = scopedServices.liveSurfaceHub;
    client.bindServices(liveSurfaceHub);
    if (closingScope) releaseScopedServices(closingScope, closingServices);
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
    snapshotPatch,
    snapshot,
  };
}

export function emitTurnEnd(
  runtime: RemoteControlRuntime,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  if (!flushQueueDrafts(runtime, pi, ctx, 'steer')) emitState(runtime, ctx);
}

const activeQueueFlushes = new WeakMap<object, Set<string>>();

export function flushQueueDrafts(
  runtime: RemoteControlRuntime,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  mode: QueueDraftMode,
): boolean {
  if (!runtime.isCurrent(ctx)) return false;
  if (
    mode === 'followUp' &&
    !isGenuineAgentSettlement(false, ctx.sessionManager.getSessionId())
  )
    return false;
  runtime.setContext(ctx, false);
  if (!runtime.isCurrent(ctx)) return false;
  const nativeController = getNativeSteeringController(
    ctx.sessionManager.getSessionId(),
  ) as { hasPendingContinuation?: () => boolean } | undefined;
  if (nativeController?.hasPendingContinuation?.()) return false;
  if (
    mode === 'steer' &&
    typeof ctx.hasPendingMessages === 'function' &&
    ctx.hasPendingMessages()
  )
    return false;
  const flushKey = `${ctx.sessionManager.getSessionId()}:${mode}`;
  const active = activeQueueFlushes.get(runtime) ?? new Set<string>();
  if (active.has(flushKey)) return false;
  const drafts = runtime.queueDrafts.take(mode);
  if (drafts.length === 0) return false;
  active.add(flushKey);
  activeQueueFlushes.set(runtime, active);
  const getCommands = (
    pi as ExtensionAPI & { getCommands?: ExtensionAPI['getCommands'] }
  ).getCommands;
  const commands = getCommands?.call(pi) ?? [];
  void (async () => {
    try {
      let draft: StoredQueueDraft | undefined = drafts[0];
      while (draft) {
        const currentDraft = draft;
        let settleAdmission!: (outcome: QueueSendSettlement) => void;
        const admission = new Promise<QueueSendSettlement>((resolve) => {
          settleAdmission = resolve;
        });
        try {
          const expanded = expandDashboardInput(currentDraft.text, commands);
          const { result, observed } = withQueueSendObservation(
            () =>
              pi.sendUserMessage(
                (currentDraft.images.length > 0
                  ? [
                      ...(expanded
                        ? [{ type: 'text' as const, text: expanded }]
                        : []),
                      ...currentDraft.images,
                    ]
                  : expanded) as Parameters<ExtensionAPI['sendUserMessage']>[0],
                { deliverAs: currentDraft.mode },
              ),
            settleAdmission,
            () => resolveQueueHandoff(runtime, ctx, currentDraft, 'entered'),
          );
          const possiblePromise: unknown = result;
          if (
            possiblePromise &&
            typeof (possiblePromise as PromiseLike<unknown>).then === 'function'
          ) {
            void Promise.resolve(possiblePromise).then(
              () => settleAdmission({ status: 'accepted' }),
              (error: unknown) =>
                settleAdmission({
                  status: 'uncertain',
                  detail:
                    error instanceof Error ? error.message : String(error),
                }),
            );
          } else if (!observed) {
            settleAdmission({
              status: 'uncertain',
              detail: 'Pi did not expose a queue-send outcome.',
            });
          }
        } catch (error) {
          if (runtime.isCurrent(ctx))
            runtime.queueDrafts.resolveHandoff(
              currentDraft,
              'failed',
              error instanceof Error ? error.message : String(error),
            );
          break;
        }
        const outcome = await admission;
        if (runtime.isCurrent(ctx))
          resolveQueueHandoff(
            runtime,
            ctx,
            currentDraft,
            outcome.status,
            outcome.status === 'uncertain' ? outcome.detail : undefined,
          );
        if (outcome.status === 'uncertain' || !runtime.isCurrent(ctx)) break;
        draft = runtime.queueDrafts.take(mode)[0];
      }
      if (runtime.isCurrent(ctx)) emitState(runtime, ctx);
    } finally {
      active.delete(flushKey);
    }
  })().catch((error: unknown) => {
    recordHarnessFailure(
      'remote-control',
      'queue-admission-worker-failed',
      error,
      flushKey,
    );
  });
  if (runtime.isCurrent(ctx)) {
    runtime.setContext(ctx, false);
    if (runtime.isCurrent(ctx)) {
      const state = liveState(ctx);
      runtime.client.sendEvent({
        type: 'runtime.stateChanged',
        state,
        snapshot: runtime.snapshotPatch?.(ctx, state) ?? { liveState: state },
      });
    }
  }
  return true;
}

function resolveQueueHandoff(
  runtime: RemoteControlRuntime,
  ctx: ExtensionContext,
  draft: StoredQueueDraft,
  status: 'accepted' | 'entered' | 'uncertain',
  detail?: string,
): void {
  if (!runtime.isCurrent(ctx)) return;
  runtime.queueDrafts.resolveHandoff(draft, status, detail);
  runtime.setContext(ctx, false);
  if (!runtime.isCurrent(ctx)) return;
  const state = liveState(ctx);
  runtime.client.sendEvent({
    type: 'runtime.stateChanged',
    state,
    snapshot: runtime.snapshotPatch?.(ctx, state) ?? { liveState: state },
  });
}

export function emitState(
  runtime: RemoteControlRuntime,
  ctx: ExtensionContext,
  forcedState?: RuntimeLiveState,
  contextTokens?: number,
): void {
  if (!runtime.isCurrent(ctx)) return;
  runtime.setContext(ctx, false);
  if (!runtime.isCurrent(ctx)) return;
  const state = forcedState ?? liveState(ctx);
  if (forcedState) runtime.setLiveState(forcedState);
  runtime.client.sendEvent({
    type: 'runtime.stateChanged',
    state,
    snapshot: runtime.snapshotPatch?.(ctx, state, contextTokens) ?? {
      liveState: state,
    },
  });
}

export function emitAgentSettlement(
  runtime: RemoteControlRuntime,
  ctx: ExtensionContext,
  closure?: Extract<BridgeEvent, { type: 'agent.settled' }>['closure'],
  responseWaitPending = false,
): void {
  const scopeId = ctx.sessionManager.getSessionId();
  const pending = pendingProcessCount(scopeId);
  if (closure && !responseWaitPending) {
    // A handed-off answer is complete even while a passive server stays alive.
    // Keep that process in the activity panel, not in the foreground wait surface.
    clearSettledBackground(scopeId);
    emitState(runtime, ctx, 'idle');
  } else if (responseWaitPending || !isGenuineAgentSettlement(false, scopeId)) {
    // Required results can be queued, or come from delegates rather than
    // processes. Keep their request wait distinct from passive activity.
    publishSettledBackground(pending, scopeId, responseWaitPending);
    emitState(runtime, ctx, 'waiting');
    return;
  } else {
    clearSettledBackground(scopeId);
    emitState(runtime, ctx);
  }
  if (!runtime.isCurrent(ctx)) return;
  runtime.client.sendEvent({
    type: 'agent.settled',
    sessionId: ctx.sessionManager.getSessionId(),
    ...(closure ? { closure } : {}),
  });
}
