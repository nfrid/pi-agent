import { createHash } from 'node:crypto';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import {
  FOREGROUND_DELEGATES_PAUSED_EVENT,
  PAUSE_REQUESTED_EVENT,
  PAUSE_RESUMED_EVENT,
  type PauseControlEvent,
} from '../pause/operations';
import { getPauseCoordinator } from '../pause/state';
import {
  beginsFreshUserTurn,
  isGenuineAgentSettlement,
} from '../shared/runtime/agent-lifecycle';
import { defineExtension } from '../shared/runtime/extension';
import {
  getScopedServices,
  getSessionScopeId,
  type SessionScopeId,
} from '../shared/runtime/scoped-services';
import { createRailPanel } from '../shared/ui/rail';
import {
  appendBranchOwnerMarker,
  branchContainsWorkflowOwner,
  branchOwnerMarkers,
  branchRuntimeKey,
  eventLeafId,
  getSessionLeafId,
} from './branch-ownership';
import { listBranchEntries } from './branches';
import { registerDelegateBranchesTool } from './branches-tool';
import {
  completionCard,
  createCompletionDelivery,
  renderBackgroundCompletion,
} from './completion-delivery';
import {
  delegateRouteCount,
  fingerprintDelegateConfig,
  getDelegateSettingsPath,
  loadDelegateConfig,
} from './config';
import {
  listActiveDelegateControlChannels,
  registerDelegateControl,
  subscribeDelegateControlLifecycle,
} from './control';
import { DelegateJobManager, type DelegateJobSnapshot } from './jobs';
import { registerDelegateJobsTool } from './jobs-tool';
import { clearDelegateSurface, publishDelegateSurface } from './live';
import { registerDelegateCapability } from './register-capability';
import { pruneDelegateSessions } from './session';
import { DelegateStatusStore } from './status';
import {
  parseChildDelegateResultSpec,
  registerChildDelegateResultTool,
} from './structured-result';
import { registerDelegateTool } from './tool';
import { delegateToolBoundary } from './tool-boundary';
import { registerDelegateTranscriptCommand } from './transcript';
import { WakeCoordinator } from './wake-coordinator';
import {
  createWakeDelivery,
  registerWakeMessageRenderer,
} from './wake-delivery';
import {
  attachWakeStore,
  latestWakeState,
  restoreWakeState,
} from './wake-store';
import { registerDelegateWakeTool } from './wake-tool';
import {
  DELEGATE_WIDGET_MAX_WIDTH,
  DELEGATE_WIDGET_MIN_WIDTH,
  renderDelegateWidget,
} from './widget';
import { createDelegateWorkflowCoordinator } from './workflow-coordinator';
import {
  attachWorkflowStore,
  latestWorkflowState,
  persistWorkflowState,
} from './workflow-store';
import { loadWorktree } from './worktree';
import { registerDelegateWorktreesCommand } from './worktrees-command';

export const DELEGATES_COMMAND_DESCRIPTION =
  'Toggle detailed subagent status or inspect delegate config';

function setDelegateToolActive(
  pi: ExtensionAPI,
  name: 'delegate_jobs' | 'delegate_branches',
  active: boolean,
): void {
  // Older test/runtime shims do not expose active-tool selection; registration
  // remains useful there, while the host keeps these tools out of the model
  // tool list until their state makes them actionable.
  const api = pi as unknown as {
    getActiveTools?: () => string[];
    setActiveTools?: (names: string[]) => void;
  };
  if (!api.getActiveTools || !api.setActiveTools) return;
  const current = api.getActiveTools();
  const next = active
    ? [...new Set([...current, name])]
    : current.filter((candidate) => candidate !== name);
  if (
    next.length !== current.length ||
    next.some((item, index) => item !== current[index])
  )
    api.setActiveTools(next);
}

/** Stable registration facade; orchestration and broker commands have separate owners. */
export default defineExtension('delegate', (pi: ExtensionAPI) => {
  registerDelegateCapability();
  const isChild = process.env.PI_DELEGATE_CHILD === '1';

  if (isChild) {
    const resultSpec = parseChildDelegateResultSpec(
      process.env.PI_DELEGATE_RESULT_SCHEMA,
    );
    if (resultSpec) registerChildDelegateResultTool(pi, resultSpec);
    registerDelegateControl(pi, process.env.PI_DELEGATE_CONTROL_FILE);
    pi.on('tool_call', (event, ctx) => {
      const reason = delegateToolBoundary(event.toolName, event.input, ctx.cwd);
      return reason ? { block: true, reason } : undefined;
    });
    return;
  }

  let jobs: DelegateJobManager | undefined;
  let workflow:
    | ReturnType<typeof createDelegateWorkflowCoordinator>
    | undefined;
  let statuses: DelegateStatusStore | undefined;
  let ui: ExtensionUIContext | undefined;
  type BranchRuntime = {
    readonly branchId: string;
    readonly workflow: ReturnType<typeof createDelegateWorkflowCoordinator>;
    readonly statuses: DelegateStatusStore;
    detachStore?: () => void;
    ownerMarkerWritten: boolean;
  };
  const branchRuntimes = new Map<string, BranchRuntime>();
  const branchLeafRuntimes = new Map<string, BranchRuntime>();
  let activeRuntime: BranchRuntime | undefined;
  let activeContext: ExtensionContext | undefined;
  type WakeBranch = {
    readonly key: string;
    readonly coordinator: WakeCoordinator;
    detachStore?: () => void;
  };
  const wakeBranches = new Map<string, WakeBranch>();
  let activeWake: WakeBranch | undefined;
  const syncWorkflowSurface = () => {
    if (!statuses) return;
    if (workflow) statuses.updateWorkflow(workflow.list());
    if (activeWake) statuses.setWakes(activeWake.coordinator.snapshot().wakes);
    if (activeContext && activeRuntime) {
      const leaf = branchRuntimeKey(
        getSessionLeafId(activeContext.sessionManager),
      );
      if (leaf) branchLeafRuntimes.set(leaf, activeRuntime);
    }
  };
  let wakeBranchKey = 'root';
  let nextWakeEpoch = 0;
  const wakeDelivery = createWakeDelivery({
    pi,
    getRuntimeActive: () => runtimeActive,
    getActiveCoordinator: () => activeWake?.coordinator,
    onEntered: (sources) => statuses?.markWorkflowDelivered(sources),
  });
  registerDelegateWakeTool(pi, () => activeWake?.coordinator);
  let scopeId: SessionScopeId = 'default';
  const sessionManagerGenerations = new WeakMap<object, number>();
  let runtimeGeneration = 0;
  let deliveryEpoch = 0;
  let runtimeActive = false;
  let widgetDetailed = true;
  const sessionLeafId = (ctx: ExtensionContext): string | null | undefined =>
    getSessionLeafId(ctx.sessionManager);
  const wakeOwnerId = (branchKey: string): string => {
    if (
      branchKey.length <= 256 &&
      ![...branchKey].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    )
      return branchKey;
    return `branch-${createHash('sha256').update(branchKey).digest('hex')}`;
  };
  const activateJobsTool = () =>
    setDelegateToolActive(pi, 'delegate_jobs', true);
  const activateBranchesTool = () =>
    setDelegateToolActive(pi, 'delegate_branches', true);
  let promptSnapshot:
    | {
        fingerprint: string;
        valid: boolean;
        error?: string;
        routeCount: number;
        loadedAt: string;
        reason: string;
      }
    | undefined;

  const ownerBranchIsActive = (ownerBranchId: string): boolean =>
    runtimeActive && activeRuntime?.branchId === ownerBranchId;

  const activateWorkflowRuntime = (
    ctx: ExtensionContext,
    branchId: string,
  ): BranchRuntime | undefined => {
    if (!jobs || !runtimeActive) return undefined;
    const existing = branchRuntimes.get(branchId);
    if (existing) {
      activeRuntime = existing;
      workflow = existing.workflow;
      statuses = existing.statuses;
      if (existing.workflow.list().length > 0)
        persistWorkflowState(existing.workflow, pi, {
          isOwnerActive: () => ownerBranchIsActive(branchId),
        });
      syncWorkflowSurface();
      return existing;
    }

    let nextStatuses: DelegateStatusStore;
    nextStatuses = new DelegateStatusStore(() => {
      syncWidget();
      if (activeRuntime?.statuses === nextStatuses)
        publishDelegateSurface(nextStatuses, scopeId);
    });
    const nextWorkflow = createDelegateWorkflowCoordinator({
      jobs,
      ownerBranchId: branchId,
      onChange: syncWorkflowSurface,
    });
    // Import only owners whose marker is in the active branch ancestry. A
    // sibling's public impl@1 is deliberately absent and can be scheduled
    // independently without colliding with this runtime.
    for (const candidate of branchRuntimes.values()) {
      if (
        candidate.branchId !== branchId &&
        branchContainsWorkflowOwner(ctx.sessionManager, candidate.branchId)
      ) {
        try {
          nextWorkflow.importFrom(candidate.workflow);
        } catch {
          // Ambiguous or incomplete persisted ancestry fails closed.
        }
      }
    }
    const persisted = latestWorkflowState(ctx);
    if (persisted) nextWorkflow.restoreMetadata(persisted);
    const runtime: BranchRuntime = {
      branchId,
      workflow: nextWorkflow,
      statuses: nextStatuses,
      ownerMarkerWritten: branchOwnerMarkers(ctx.sessionManager).includes(
        branchId,
      ),
    };
    runtime.detachStore = attachWorkflowStore(nextWorkflow, pi, {
      isOwnerActive: () => ownerBranchIsActive(branchId),
      onPersist: () => {
        const leaf = branchRuntimeKey(getSessionLeafId(ctx.sessionManager));
        if (leaf) branchLeafRuntimes.set(leaf, runtime);
      },
    });
    branchRuntimes.set(branchId, runtime);
    const currentLeaf = branchRuntimeKey(getSessionLeafId(ctx.sessionManager));
    if (currentLeaf) branchLeafRuntimes.set(currentLeaf, runtime);
    activeRuntime = runtime;
    workflow = nextWorkflow;
    statuses = nextStatuses;
    if (nextWorkflow.list().length > 0)
      persistWorkflowState(nextWorkflow, pi, {
        isOwnerActive: () => ownerBranchIsActive(branchId),
      });
    syncWorkflowSurface();
    return runtime;
  };

  const ensureBranchOwner = (runtime: BranchRuntime, ctx: ExtensionContext) => {
    if (runtime.ownerMarkerWritten) return;
    if (!runtimeActive || activeRuntime !== runtime)
      throw new Error('Delegate branch ownership is not active.');
    appendBranchOwnerMarker(pi, runtime.branchId);
    runtime.ownerMarkerWritten = true;
    const leaf = branchRuntimeKey(getSessionLeafId(ctx.sessionManager));
    if (leaf) branchLeafRuntimes.set(leaf, runtime);
    // appendEntry advances the host leaf. Keep the old immutable owner ID as
    // the runtime key; subsequent navigation uses the persisted marker.
    void ctx;
  };

  const detachActiveWake = () => {
    if (!activeWake) return;
    activeWake.detachStore?.();
    activeWake.detachStore = undefined;
    activeWake.coordinator.setDispatchHandler(undefined);
    activeWake = undefined;
  };

  const disposeWakeRuntime = () => {
    detachActiveWake();
    for (const branch of wakeBranches.values()) branch.coordinator.dispose();
    wakeBranches.clear();
  };

  const activateWakeBranch = (
    ctx: ExtensionContext,
    key: string,
    allowLegacyMigration = false,
  ): void => {
    const activeWorkflow = workflow;
    if (!activeWorkflow || !runtimeActive) return;
    const current = activeWake;
    if (current?.key === key) return;
    detachActiveWake();
    const existing = wakeBranches.get(key);
    let branch = existing;
    if (!branch) {
      const persisted = latestWakeState(ctx);
      // The branch key is part of ownership and therefore of every delivery
      // acknowledgement. Inherited entries from a fork cannot acknowledge a
      // wake on the newly selected branch.
      // Legacy snapshots predate branch-qualified ownership. Migrate them only
      // during session startup onto the branch that actually contains the
      // entry; never inherit them during a later tree switch.
      const legacyOwner =
        allowLegacyMigration && persisted?.ownerSessionId === scopeId;
      const ownerSessionId = legacyOwner ? scopeId : wakeOwnerId(key);
      const inheritedEpoch =
        persisted?.ownerSessionId === ownerSessionId
          ? persisted.ownerEpoch
          : undefined;
      const ownerEpoch =
        inheritedEpoch ?? (nextWakeEpoch > 0 ? nextWakeEpoch : 0);
      nextWakeEpoch = Math.max(nextWakeEpoch, ownerEpoch + 1);
      const coordinator = new WakeCoordinator({
        workflow: activeWorkflow,
        ownerSessionId,
        ownerEpoch,
        onChange: syncWorkflowSurface,
      });
      if (persisted?.ownerSessionId === ownerSessionId)
        restoreWakeState(coordinator, ctx);
      branch = { key, coordinator };
      wakeBranches.set(key, branch);
    }
    activeWake = branch;
    branch.detachStore = attachWakeStore(branch.coordinator, pi);
    branch.coordinator.setDispatchHandler(wakeDelivery.dispatch);
    syncWorkflowSurface();
  };

  const delivery = createCompletionDelivery({
    pi,
    getRuntimeActive: () => runtimeActive,
    getDeliveryEpoch: () => deliveryEpoch,
    getRunningCount: () => jobs?.runningCount ?? 0,
    getStatuses: () => statuses,
    getUi: () => ui,
    getPaused: () => getPauseCoordinator(scopeId).isActive(),
  });

  subscribeDelegateControlLifecycle((event) => {
    if (!runtimeActive) return;
    const coordinator = getPauseCoordinator(scopeId);
    const snapshot = coordinator.snapshot();
    if (!snapshot) return;
    if (event.type === 'open') {
      if (event.channel.ownerSessionId !== scopeId) return;
      coordinator.enrollDelegates(snapshot.generation, [
        event.channel.participantId,
      ]);
      event.channel.pause(snapshot.generation);
    } else if (event.type === 'bind') {
      if (snapshot.delegateIds.includes(event.participantId))
        statuses?.setPauseState(event.statusId, 'pausing', Date.now());
    } else if (event.type === 'ack') {
      if (
        event.generation !== snapshot.generation ||
        !snapshot.delegateIds.includes(event.participantId)
      )
        return;
      coordinator.markDelegateReached(event.generation, event.participantId);
      const channel = listActiveDelegateControlChannels().find(
        (candidate) => candidate.participantId === event.participantId,
      );
      const statusId = channel?.statusId();
      if (statusId) statuses?.setPauseState(statusId, 'paused', Date.now());
      const reached = coordinator.snapshot();
      if (
        reached &&
        reached.reachedDelegateIds.length === reached.delegateIds.length &&
        reached.delegateIds.some((participantId) =>
          listActiveDelegateControlChannels().some(
            (candidate) =>
              candidate.participantId === participantId &&
              candidate.runKind === 'foreground',
          ),
        )
      )
        pi.events.emit(FOREGROUND_DELEGATES_PAUSED_EVENT, {
          scopeId,
          generation: reached.generation,
        });
    } else {
      if (event.ownerSessionId !== scopeId) return;
      if (event.statusId) statuses?.setPauseState(event.statusId, undefined);
      coordinator.removeDelegate(snapshot.generation, event.participantId);
    }
  });
  if (pi.events)
    pi.events.on(PAUSE_REQUESTED_EVENT, (value) => {
      const event = value as PauseControlEvent;
      if (!runtimeActive || event.scopeId !== scopeId) return;
      const coordinator = getPauseCoordinator(scopeId);
      const participants = listActiveDelegateControlChannels().filter(
        (channel) => channel.ownerSessionId === event.scopeId,
      );
      coordinator.enrollDelegates(
        event.generation,
        participants.map((channel) => channel.participantId),
      );
      for (const channel of participants) {
        channel.pause(event.generation);
        const statusId = channel.statusId();
        if (statusId) statuses?.setPauseState(statusId, 'pausing', Date.now());
      }
    });
  if (pi.events)
    pi.events.on(PAUSE_RESUMED_EVENT, (value) => {
      const event = value as PauseControlEvent;
      const targetIds = new Set(event.delegateIds);
      for (const channel of listActiveDelegateControlChannels()) {
        if (
          channel.ownerSessionId !== event.scopeId ||
          !targetIds.has(channel.participantId)
        )
          continue;
        channel.resume(event.generation);
        const statusId = channel.statusId();
        if (statusId) statuses?.setPauseState(statusId, undefined);
      }
      if (runtimeActive && event.scopeId === scopeId)
        delivery.flushCompletions();
    });

  const activeStatuses = () => statuses?.list() ?? [];

  // Refreshed on a timer because the rendered rows include elapsed time.
  const widget = createRailPanel({
    key: 'delegate-jobs',
    side: 'right',
    maxWidth: DELEGATE_WIDGET_MAX_WIDTH,
    minWidth: DELEGATE_WIDGET_MIN_WIDTH,
    refreshMs: 1_000,
    isActive: () => activeStatuses().length > 0,
    render: (width, theme) => {
      const pausedAt = getPauseCoordinator(scopeId).snapshot()?.pausedAt;
      return renderDelegateWidget(
        activeStatuses(),
        widgetDetailed,
        width,
        theme,
        pausedAt ?? Date.now(),
      );
    },
    onError: (error) =>
      console.error('delegate: failed to update the jobs widget', error),
  });

  const syncWidget = () => widget.sync();

  pi.on('session_start', async (event, ctx) => {
    const generation = ++runtimeGeneration;
    const sessionScopeId = getSessionScopeId(ctx);
    const previousScopeId = scopeId;
    const closingJobs = jobs;
    const closingRuntimes = [...branchRuntimes.values()];

    // Invalidate and detach the previous generation immediately, including a
    // repeated session_start for the same session ID.
    runtimeActive = false;
    jobs = undefined;
    workflow = undefined;
    statuses = undefined;
    activeRuntime = undefined;
    activeContext = undefined;
    for (const runtime of closingRuntimes) runtime.detachStore?.();
    branchRuntimes.clear();
    branchLeafRuntimes.clear();
    disposeWakeRuntime();
    delivery.clearTimer();
    delivery.clearPending();
    delivery.resetAutomaticDelivery();
    widget.detach();
    for (const runtime of closingRuntimes) await runtime.workflow.dispose();
    await closingJobs?.dispose();
    const previousServices = getScopedServices(previousScopeId);
    if (previousServices.delegateWorkflow)
      previousServices.delegateWorkflow = undefined;
    if (previousScopeId !== 'default') clearDelegateSurface(previousScopeId);
    if (generation !== runtimeGeneration) return;

    const branchEntries = await listBranchEntries({
      scope: 'session',
      sessionId: sessionScopeId,
    }).catch(() => []);
    if (generation !== runtimeGeneration) return;

    scopeId = sessionScopeId;
    sessionManagerGenerations.set(ctx.sessionManager, generation);
    clearDelegateSurface(sessionScopeId);
    const promptConfig = loadDelegateConfig(ctx.cwd);
    promptSnapshot = {
      fingerprint: fingerprintDelegateConfig(promptConfig),
      valid: !promptConfig.error,
      ...(promptConfig.error ? { error: promptConfig.error } : {}),
      routeCount: delegateRouteCount(promptConfig),
      loadedAt: new Date().toISOString(),
      reason: event.reason ?? 'unknown',
    };
    runtimeActive = true;
    ui = ctx.hasUI ? ctx.ui : undefined;
    deliveryEpoch = 0;
    nextWakeEpoch = 0;
    const initialBranchId =
      branchRuntimeKey(sessionLeafId(ctx)) ?? 'legacy-root';
    wakeBranchKey = `${sessionScopeId}:${initialBranchId}`;
    widgetDetailed = true;
    widget.attach(ui);
    pruneDelegateSessions({
      isWorktreeRetained: (id) => Boolean(loadWorktree(id)),
    });
    const scopedServices = getScopedServices(sessionScopeId);
    jobs = new DelegateJobManager({
      scopeId: sessionScopeId,
      pendingProcesses: scopedServices.pendingProcesses,
      isOwnerBranchActive: (ownerBranchId) =>
        ownerBranchIsActive(ownerBranchId),
      // Coordinator-owned jobs settle through workflow terminal listeners and
      // must not also appear as legacy automatic completions.
      onSettled: (job) => {
        if (!job.attemptIdentity) delivery.queueCompletion(job);
      },
    });
    runtimeActive = true;
    activeContext = ctx;
    const initialRuntime = activateWorkflowRuntime(ctx, initialBranchId);
    if (!initialRuntime)
      throw new Error('Delegate branch runtime unavailable.');
    scopedServices.delegateWorkflow = initialRuntime.workflow;
    registerDelegateTool(
      pi,
      ctx.cwd,
      {
        getWorkflow: () => activeRuntime?.workflow,
        workflow: initialRuntime.workflow,
        manager: jobs,
        statuses: initialRuntime.statuses,
        getStatuses: () => activeRuntime?.statuses,
        getBranchId: () => activeRuntime?.branchId,
        getDeliveryEpoch: () => deliveryEpoch,
        activateJobs: activateJobsTool,
        activateBranches: activateBranchesTool,
        ensureBranchOwner: (currentCtx) => {
          if (!activeRuntime)
            throw new Error('Delegate branch runtime unavailable.');
          ensureBranchOwner(activeRuntime, currentCtx);
        },
      },
      promptConfig,
    );
    registerDelegateJobsTool(
      pi,
      jobs,
      (completed) => {
        const entered = new Set(
          completed
            .filter((job) => job.deliveryEpoch === deliveryEpoch)
            .map((job) => job.id),
        );
        delivery.filterPending(
          (job) => job.deliveryEpoch !== deliveryEpoch || !entered.has(job.id),
        );
        statuses?.settleJobs(completed);
        statuses?.jobResultEntered(completed.map((job) => job.id));
      },
      delivery.automaticDeliveryState,
      initialRuntime.workflow,
      () => activeRuntime?.workflow,
    );
    registerDelegateBranchesTool(pi);
    // Keep the broker tools registered for stable extension ownership, but do
    // not expose either one until a job or retained branch makes it useful.
    setDelegateToolActive(pi, 'delegate_jobs', false);
    setDelegateToolActive(pi, 'delegate_branches', false);
    if (branchEntries.length > 0) activateBranchesTool();
    activateWakeBranch(ctx, wakeBranchKey, true);
    syncWidget();
  });

  pi.on('session_tree', (event, ctx) => {
    if (!runtimeActive) return;
    // Every tree transition invalidates legacy automatic completion delivery,
    // even when the event is stale or foreign. Wake activation remains strict.
    deliveryEpoch++;
    delivery.resetAutomaticDelivery();
    const eventGeneration = sessionManagerGenerations.get(ctx.sessionManager);
    if (
      eventGeneration !== runtimeGeneration ||
      getSessionScopeId(ctx) !== scopeId
    )
      return;
    const destinationLeaf = eventLeafId(event);
    const leafId =
      destinationLeaf === undefined ? sessionLeafId(ctx) : destinationLeaf;
    // Old host shims without branch identity cannot safely distinguish a fork;
    // keep the current runtime and do not import or expose another branch.
    if (leafId === undefined) return;
    activeContext = ctx;
    const leafKey = branchRuntimeKey(leafId);
    if (!leafKey) return;
    const knownRuntime = branchLeafRuntimes.get(leafKey);
    const manager = ctx.sessionManager as ExtensionContext['sessionManager'] & {
      getChildren?: (parentId: string) => unknown[];
    };
    const targetIsInterior =
      knownRuntime !== undefined &&
      (leafId === null
        ? ctx.sessionManager.getEntries().length > 0
        : typeof manager.getChildren === 'function'
          ? manager.getChildren(leafId).length > 0
          : true);
    // Reuse only a known leaf that is still a tip. Navigating to a mapped
    // interior entry creates a sibling branch and therefore a fresh namespace.
    // Older host shims without getChildren fail closed instead of sharing.
    const known = targetIsInterior ? undefined : knownRuntime;
    const target = known ?? activateWorkflowRuntime(ctx, leafKey);
    if (!target) return;
    branchLeafRuntimes.set(leafKey, target);
    activeRuntime = target;
    workflow = target.workflow;
    statuses = target.statuses;
    wakeBranchKey = `${scopeId}:${target.branchId}`;
    activateWakeBranch(ctx, wakeBranchKey);
    syncWorkflowSurface();
    syncWidget();
  });
  pi.on('context', (event) => {
    // Keep the automatic-delivery marker through context entry so a later
    // peek does not replay the same settled completion.
    delivery.markAutomaticDeliveriesEntered(event.messages);
    return { messages: wakeDelivery.filterContext(event.messages) };
  });
  // Unlike background-terminals, this widget is not force-remounted at agent
  // boundaries: a delegate run is live across them, and tearing the component
  // down mid-run would discard the mounted render loop. A plain sync refreshes
  // the existing component in place.
  pi.on('agent_start', syncWidget);
  pi.on('tool_call', (event) => {
    if (
      event.toolName === 'delegate' &&
      getPauseCoordinator(scopeId).isActive()
    )
      return {
        block: true,
        reason: 'Cannot start a delegate while the runtime is paused.',
      };
  });
  pi.on('input', (event) => {
    if (!beginsFreshUserTurn(event, scopeId)) return;
    statuses?.parentUserMessage();
    syncWidget();
  });
  pi.on('agent_settled', () => {
    const genuinelySettled = isGenuineAgentSettlement(
      delivery.pendingCount() > 0 || delivery.hasQueuedAutomaticDeliveries(),
      scopeId,
    );
    // A successfully queued steer prevents settlement until it enters context.
    // If the parent settles first, dispatch failed asynchronously and explicit
    // inspection must remain able to return the retained handoff.
    delivery.clearUnenteredAutomaticDeliveries();
    if (genuinelySettled) statuses?.parentSettled();
    syncWidget();
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    const closingScopeId = getSessionScopeId(ctx);
    const eventGeneration = sessionManagerGenerations.get(ctx.sessionManager);
    if (
      eventGeneration === undefined
        ? scopeId !== closingScopeId
        : eventGeneration !== runtimeGeneration
    )
      return;
    runtimeGeneration++;
    runtimeActive = false;
    delivery.clearTimer();
    delivery.clearPending();
    delivery.resetAutomaticDelivery();
    widget.detach();
    const closing = jobs;
    const closingRuntimes = [...branchRuntimes.values()];
    jobs = undefined;
    workflow = undefined;
    statuses = undefined;
    activeRuntime = undefined;
    activeContext = undefined;
    for (const runtime of closingRuntimes) runtime.detachStore?.();
    branchRuntimes.clear();
    branchLeafRuntimes.clear();
    disposeWakeRuntime();
    for (const runtime of closingRuntimes) await runtime.workflow.dispose();
    // Workflow coordinators use this shared manager but do not own it.
    await closing?.dispose();
    const scopedServices = getScopedServices(closingScopeId);
    if (scopedServices.delegateWorkflow)
      scopedServices.delegateWorkflow = undefined;
    clearDelegateSurface(closingScopeId);
    ui = undefined;
    if (scopeId === closingScopeId) scopeId = 'default';
  });

  pi.registerMessageRenderer(
    'delegate-job-result',
    (message, { expanded, outputPad }, theme) => {
      const details = (message.details ?? {}) as {
        jobs?: DelegateJobSnapshot[];
      };
      return renderBackgroundCompletion(
        completionCard(details.jobs ?? []),
        { expanded, outputPad },
        theme,
      );
    },
  );
  registerWakeMessageRenderer(pi);

  pi.registerCommand('delegates', {
    description: DELEGATES_COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (argument === 'config') {
        const snapshot = promptSnapshot;
        const current = loadDelegateConfig(ctx.cwd);
        const currentFingerprint = fingerprintDelegateConfig(current);
        const currentRouteCount = delegateRouteCount(current);
        const currentValid = !current.error;
        const comparison = snapshot
          ? snapshot.fingerprint === currentFingerprint
            ? 'same'
            : 'differs'
          : 'unavailable';
        const guidance = !currentValid
          ? 'Fix current settings before delegating; delegate execution is unavailable with current settings. /reload refreshes prompt guidance after the fix.'
          : !snapshot
            ? '/reload establishes prompt guidance. Delegate execution re-reads current settings on demand.'
            : snapshot.valid && comparison === 'same'
              ? 'Prompt guidance is current. Delegate execution re-reads current settings on demand.'
              : '/reload refreshes prompt guidance. Delegate execution re-reads current settings on demand.';
        const conciseError = (error: string | undefined) =>
          error ? error.replace(/\s+/g, ' ').slice(0, 240) : undefined;
        const promptError = conciseError(snapshot?.error);
        const currentError = conciseError(current.error);
        const sourcePath = (() => {
          try {
            const matching = pi
              .getCommands()
              .filter(
                (entry) =>
                  entry.name === 'delegates' &&
                  entry.description === DELEGATES_COMMAND_DESCRIPTION,
              );
            if (matching.length !== 1) return 'unknown';
            const sourcePath = matching[0]?.sourceInfo?.path;
            return typeof sourcePath === 'string' && sourcePath.trim()
              ? sourcePath
              : 'unknown';
          } catch {
            return 'unknown';
          }
        })();
        const report = [
          `Settings path: ${getDelegateSettingsPath()}`,
          `Prompt-loaded: fingerprint=${snapshot?.fingerprint ?? 'unknown'}; valid=${snapshot ? (snapshot.valid ? 'yes' : 'no') : 'unknown'}; routes=${snapshot?.routeCount ?? 'unknown'}${promptError ? `; error=${promptError}` : ''}; time=${snapshot?.loadedAt ?? 'unknown'}; lifecycle=session_start (reason=${snapshot?.reason ?? 'unknown'})`,
          `Current settings: fingerprint=${currentFingerprint}; valid=${currentValid ? 'yes' : 'no'}; routes=${currentRouteCount}${currentError ? `; error=${currentError}` : ''}`,
          `Comparison: ${comparison}`,
          `Guidance: ${guidance}`,
          `Extension source: ${sourcePath}`,
        ].join('\n');
        if (ctx.hasUI) ctx.ui.notify(report, 'info');
        else console.log(report);
        return;
      }
      if (argument) {
        const message = `Unknown /delegates argument "${argument}". Use /delegates for the widget toggle or /delegates config for configuration diagnostics.`;
        if (ctx.hasUI) ctx.ui.notify(message, 'error');
        else console.error(message);
        return;
      }
      widgetDetailed = !widgetDetailed;
      syncWidget();
      if (!ctx.hasUI)
        console.log(
          widgetDetailed
            ? 'Detailed delegate status enabled.'
            : 'Compact delegate status enabled.',
        );
    },
  });

  registerDelegateWorktreesCommand(pi);
  registerDelegateTranscriptCommand(pi);
});
