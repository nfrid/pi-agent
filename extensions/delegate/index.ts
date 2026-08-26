import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
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
import { registerDelegateChangesTool } from './changes-tool';
import {
  COMPLETION_WAVE_BURST_MS,
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
import { isExplicitGate, registerDelegateGateTool } from './gate-tool';
import { HostedCompletionAcker } from './hosted-completion-ack';
import { DelegateJobManager, type DelegateJobSnapshot } from './jobs';
import { registerDelegateJobsTool } from './jobs-tool';
import { clearDelegateSurface, publishDelegateSurface } from './live';
import { registerDelegateCapability } from './register-capability';
import {
  type RestoredDelegateDependencies,
  reconcileRestoredHostedAttempts,
} from './restore';
import { serializeDelegateRunForPublic } from './serialize';
import { archiveOldSessionFiles, pruneDelegateSessions } from './session';
import { DelegateStatusStore } from './status';
import { registerDelegateTool } from './tool';
import { delegateToolBoundary } from './tool-boundary';
import { buildOutputFileHandoff } from './tool-result';
import { registerDelegateTranscriptCommand } from './transcript';
import { createRun, type DelegatedRun } from './types';
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
import {
  DELEGATE_WIDGET_MAX_WIDTH,
  DELEGATE_WIDGET_MIN_WIDTH,
  renderDelegateWidget,
} from './widget';
import { createDelegateWorkflowCoordinator } from './workflow-coordinator';
import {
  attachWorkflowStore,
  latestWorkflowState,
  persistWorkflowDelta,
  seedWorkflowPersistence,
} from './workflow-store';
import { loadWorktree } from './worktree';
import { registerDelegateWorktreesCommand } from './worktrees-command';

export const DELEGATES_COMMAND_DESCRIPTION =
  'Toggle detailed subagent status or inspect delegate config';

function setDelegateToolActive(
  pi: ExtensionAPI,
  name: 'delegate_jobs' | 'delegate_changes',
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
  let hostedCompletionAcker: HostedCompletionAcker | undefined;
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
  const syncWorkflowSurface = (mapActiveLeaf = true) => {
    if (!statuses) return;
    if (workflow) statuses.updateWorkflow(workflow.list());
    if (activeWake) statuses.setWakes(activeWake.coordinator.snapshot().wakes);
    if (mapActiveLeaf && activeContext && activeRuntime) {
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
    getDeliveryBroker: () => getScopedServices(scopeId).backgroundDeliveries,
    getOutstanding: (sources) => {
      const sourceSet = new Set(sources);
      return (
        activeRuntime?.workflow
          .list()
          .filter(
            (attempt) =>
              !sourceSet.has(attempt.identity) &&
              ['scheduled', 'queued', 'running'].includes(attempt.state),
          )
          .map((attempt) =>
            attempt.waitingFor.length > 0
              ? `${attempt.identity} — waiting for ${attempt.waitingFor.join(', ')}`
              : `${attempt.identity} — ${attempt.state}`,
          ) ?? []
      );
    },
    onEntered: (sources) => {
      statuses?.markWorkflowDelivered(sources);
      void hostedCompletionAcker
        ?.entered(sources)
        .catch((error) =>
          console.error(
            'delegate: failed to acknowledge hosted completion',
            error,
          ),
        );
      reconcileEagerDelivery();
    },
  });
  registerDelegateGateTool(pi, () => activeWake?.coordinator, {
    onRegistered: (registered, coordinator) => {
      const selected = new Set(registered.references);
      for (const wake of coordinator
        .list()
        .filter(
          (candidate) =>
            candidate.id.startsWith('eager-') &&
            candidate.references.some((reference) => selected.has(reference)),
        )) {
        const cancelled = coordinator.cancel(
          wake.id,
          'Selected by an explicit delegate gate.',
        );
        getScopedServices(scopeId).backgroundDeliveries.cancel(
          `delegate-wake:${cancelled.deliveryKey}`,
        );
      }
      reconcileEagerDelivery();
    },
    onCancelled: (wake) =>
      getScopedServices(scopeId).backgroundDeliveries.cancel(
        `delegate-wake:${wake.deliveryKey}`,
      ),
  });
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
    setDelegateToolActive(pi, 'delegate_changes', true);
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

  let eagerDeliveryTimer: ReturnType<typeof setTimeout> | undefined;

  function flushEagerDelivery(): void {
    eagerDeliveryTimer = undefined;
    if (!runtimeActive || !activeRuntime || !activeWake) return;
    const coordinator = activeWake.coordinator;
    const delivered = new Set(coordinator.enteredSourceIdentities());
    const active = coordinator.list();
    const explicitlyHeld = new Set(
      active.filter(isExplicitGate).flatMap((wake) => [...wake.references]),
    );
    const alreadyQueued = new Set(
      active
        .filter((wake) => wake.id.startsWith('eager-'))
        .flatMap((wake) => [...wake.references]),
    );
    const ready = activeRuntime.workflow
      .list()
      .filter(
        (attempt) =>
          attempt.ownerBranchId === activeRuntime?.branchId &&
          [
            'success',
            'error',
            'timed-out',
            'aborted',
            'cancelled',
            'blocked',
          ].includes(attempt.state) &&
          !delivered.has(attempt.identity) &&
          !explicitlyHeld.has(attempt.identity) &&
          !alreadyQueued.has(attempt.identity),
      )
      .map((attempt) => attempt.identity)
      .sort();
    if (ready.length === 0) return;
    const id = `eager-${createHash('sha256')
      .update(ready.join('\n'))
      .digest('hex')
      .slice(0, 24)}`;
    if (coordinator.get(id)) return;
    coordinator.register({
      id,
      condition:
        ready.length === 1 ? { node: ready[0] as string } : { all: ready },
      payload: ['handoff', 'metadata'],
    });
  }

  function reconcileEagerDelivery(): void {
    if (!runtimeActive || eagerDeliveryTimer) return;
    eagerDeliveryTimer = setTimeout(
      flushEagerDelivery,
      COMPLETION_WAVE_BURST_MS,
    );
    eagerDeliveryTimer.unref?.();
  }

  const allocateForkOwnerId = (): string => {
    let ownerId: string;
    do ownerId = `branch-${randomUUID()}`;
    while (branchRuntimes.has(ownerId));
    return ownerId;
  };

  const activateWorkflowRuntime = (
    ctx: ExtensionContext,
    branchId: string,
    options: {
      mapCurrentLeaf?: boolean;
      deferInitialFlush?: boolean;
    } = {},
  ): BranchRuntime | undefined => {
    if (!jobs || !runtimeActive) return undefined;
    const mapCurrentLeaf = options.mapCurrentLeaf !== false;
    const existing = branchRuntimes.get(branchId);
    if (existing) {
      activeRuntime = existing;
      workflow = existing.workflow;
      statuses = existing.statuses;
      // Re-activation is also the retry point for changes that occurred while
      // this owner was inactive (or whose previous append failed). A delta
      // flush is a no-op when the durable baseline is already current.
      persistWorkflowDelta(existing.workflow, pi, {
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
    nextWorkflow.subscribeTerminal(() => reconcileEagerDelivery());
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
    // Legacy v1 snapshots predate ownerBranchId; bind those records to the
    // currently activated owner while preserving explicit owners in deltas.
    if (persisted) nextWorkflow.restoreMetadata(persisted, branchId);
    // The loaded journal is the baseline. Imported live records not present in
    // it remain dirty and are emitted by the post-activation delta flush.
    seedWorkflowPersistence(nextWorkflow, persisted);
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
    if (mapCurrentLeaf && currentLeaf)
      branchLeafRuntimes.set(currentLeaf, runtime);
    activeRuntime = runtime;
    workflow = nextWorkflow;
    statuses = nextStatuses;
    if (!options.deferInitialFlush)
      persistWorkflowDelta(nextWorkflow, pi, {
        isOwnerActive: () => ownerBranchIsActive(branchId),
      });
    // An interior fork deliberately avoids mapping its source leaf. The
    // caller writes the owner marker first, then the resulting marker/tip is
    // the only leaf associated with this fresh runtime.
    syncWorkflowSurface(mapCurrentLeaf);
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
    void hostedCompletionAcker
      ?.entered(branch.coordinator.enteredSourceIdentities())
      .catch((error) =>
        console.error(
          'delegate: failed to retry hosted completion acknowledgement',
          error,
        ),
      );
    syncWorkflowSurface();
  };

  const delivery = createCompletionDelivery({
    pi,
    getRuntimeActive: () => runtimeActive,
    getDeliveryEpoch: () => deliveryEpoch,
    getRunningCount: () => jobs?.runningCount ?? 0,
    getStatuses: () => statuses,
    getUi: () => ui,
    getDeliveryBroker: () => getScopedServices(scopeId).backgroundDeliveries,
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

  const archiveOldParentSessions = (ctx: ExtensionContext): void => {
    const sessionManager =
      ctx.sessionManager as ExtensionContext['sessionManager'] & {
        getSessionDir?: () => string;
        getSessionFile?: () => string | undefined;
      };
    const directory = sessionManager.getSessionDir?.();
    const sessionFile = sessionManager.getSessionFile?.();
    if (!directory) return;
    archiveOldSessionFiles({
      directory,
      archiveDirectory: path.join(
        path.dirname(path.dirname(directory)),
        'session-archive',
        'sessions',
        path.basename(directory),
      ),
      ...(sessionFile ? { excludePaths: [sessionFile] } : {}),
    });
  };

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
    hostedCompletionAcker = undefined;
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
    previousServices.backgroundDeliveries.cancelPrefix('delegate-jobs:');
    previousServices.backgroundDeliveries.cancelPrefix('delegate-wake:');
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
    const resumableOwner =
      event.reason === 'fork' || event.reason === 'new'
        ? undefined
        : branchOwnerMarkers(ctx.sessionManager).at(-1);
    const initialBranchId =
      resumableOwner ?? branchRuntimeKey(sessionLeafId(ctx)) ?? 'legacy-root';
    wakeBranchKey = `${sessionScopeId}:${initialBranchId}`;
    widgetDetailed = true;
    widget.attach(ui);
    archiveOldParentSessions(ctx);
    pruneDelegateSessions({
      isWorktreeRetained: (id) => Boolean(loadWorktree(id)),
    });
    const scopedServices = getScopedServices(sessionScopeId);
    scopedServices.backgroundDeliveries.bind(pi);
    jobs = new DelegateJobManager({
      scopeId: sessionScopeId,
      pendingProcesses: scopedServices.pendingProcesses,
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
    hostedCompletionAcker = new HostedCompletionAcker({
      ownerSessionId: sessionScopeId,
      getWorkflow: () => workflow,
    });
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
    registerDelegateChangesTool(pi, () => activeRuntime?.workflow);
    // Keep the broker tools registered for stable extension ownership, but do
    // not expose either one until a job or retained branch makes it useful.
    setDelegateToolActive(pi, 'delegate_jobs', false);
    setDelegateToolActive(pi, 'delegate_changes', false);
    if (branchEntries.length > 0) activateBranchesTool();
    activateWakeBranch(ctx, wakeBranchKey, true);
    reconcileEagerDelivery();

    // Reattach durable hosted links only after the owner workflow/store and
    // tools are live. The generation guard prevents a replaced session from
    // mutating the new runtime while an old reconciliation is still running.
    const restoredStatusIds = new Map<string, string>();
    const pendingRestoredRuns = new Map<string, DelegatedRun>();
    const restoreDependencies: RestoredDelegateDependencies = {
      materialize: async (runs) => {
        const handoff = await buildOutputFileHandoff(runs);
        const publicRuns = runs.map((run) =>
          serializeDelegateRunForPublic(run),
        );
        return { runs: publicRuns, retainedRuns: runs, handoff };
      },
      onRunUpdate: (run) => {
        const identity = run.workflowAttempt?.identity;
        if (!identity) return;
        const statusId = restoredStatusIds.get(identity);
        if (statusId) statuses?.update(statusId, run);
        else pendingRestoredRuns.set(identity, run);
      },
    };
    reconcileRestoredHostedAttempts({
      parentSessionId: sessionScopeId,
      manager: jobs,
      coordinator: initialRuntime.workflow,
      isGenerationActive: () =>
        generation === runtimeGeneration &&
        runtimeActive &&
        activeRuntime?.branchId === initialRuntime.branchId,
      dependencies: restoreDependencies,
      onRestored: (restored, link) => {
        activateJobsTool();
        const initialRun = createRun(
          `${link.logicalId}@${link.attempt.ordinal}`,
          restored.session.routing,
          {
            runId: link.processJobId,
            workflowAttempt: link.attempt,
            sessionId: restored.session.sessionId,
            lineageId: restored.session.lineageId,
            name: restored.session.name ?? link.identity,
            context: 'continuation',
            allowWrites: restored.session.allowWrites === true,
            capabilities: restored.session.capabilities
              ? [...restored.session.capabilities]
              : [],
            isolation: restored.session.isolation,
          },
        );
        const statusId = statuses?.start([initialRun], 'background')[0];
        if (!statusId) return;
        restoredStatusIds.set(link.identity, statusId);
        statuses?.setJobId(statusId, restored.job.id);
        statuses?.setWorkflow(
          statusId,
          initialRuntime.workflow.require(link.identity),
        );
        const pending = pendingRestoredRuns.get(link.identity);
        if (pending) {
          pendingRestoredRuns.delete(link.identity);
          statuses?.update(statusId, pending);
        }
      },
      onFailure: (link, attempt) => {
        activateJobsTool();
        const failedRun = createRun(
          `${link.logicalId}@${link.attempt.ordinal}`,
          undefined,
          {
            runId: link.processJobId,
            workflowAttempt: link.attempt,
            sessionId: link.sessionId,
            name: link.identity,
            context: 'continuation',
            capabilities: attempt.capabilities ? [...attempt.capabilities] : [],
            isolation: 'shared',
          },
        );
        failedRun.state = 'error';
        failedRun.exitCode = 1;
        failedRun.stopReason = 'error';
        failedRun.errorMessage = attempt.reason;
        failedRun.finishedAt = Date.now();
        const statusId = statuses?.start([failedRun], 'background')[0];
        if (statusId) statuses?.setWorkflow(statusId, attempt);
      },
    });
    syncWorkflowSurface();
    syncWidget();
  });

  pi.on('session_tree', (event, ctx) => {
    if (!runtimeActive) return;
    // Every tree transition invalidates legacy automatic completion delivery,
    // even when the event is stale or foreign. Wake activation remains strict.
    getScopedServices(scopeId).backgroundDeliveries.cancelPrefix(
      `delegate-jobs:${deliveryEpoch}:`,
    );
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
    const summarizedFork =
      typeof event === 'object' &&
      event !== null &&
      Object.hasOwn(event, 'summaryEntry') &&
      (event as { summaryEntry?: unknown }).summaryEntry !== undefined;
    const targetIsInterior =
      summarizedFork ||
      (leafId === null
        ? ctx.sessionManager.getEntries().length > 0
        : typeof manager.getChildren === 'function'
          ? manager.getChildren(leafId).length > 0
          : knownRuntime !== undefined);
    // Reuse only a known leaf that is still a tip. Navigating to a mapped
    // interior entry creates a sibling branch and therefore a fresh namespace.
    // Older host shims without getChildren fail closed instead of sharing.
    const known = targetIsInterior ? undefined : knownRuntime;
    const persistedOwner = targetIsInterior
      ? undefined
      : branchOwnerMarkers(ctx.sessionManager).at(-1);
    // An interior/summarized target is not a runtime key. In particular, the
    // target leaf may already identify an older runtime through a stale map.
    // Allocate an opaque owner before activation and do not map the source
    // leaf; the owner marker below establishes the new branch tip.
    const targetBranchId = targetIsInterior
      ? allocateForkOwnerId()
      : (persistedOwner ?? leafKey);
    const target =
      known ??
      activateWorkflowRuntime(
        ctx,
        targetBranchId,
        targetIsInterior
          ? { mapCurrentLeaf: false, deferInitialFlush: true }
          : undefined,
      );
    if (!target) return;
    if (!targetIsInterior) branchLeafRuntimes.set(leafKey, target);
    if (targetIsInterior) {
      ensureBranchOwner(target, ctx);
      // The marker is the first durable write for this fresh owner. Any
      // imported live metadata is flushed only after that marker exists.
      persistWorkflowDelta(target.workflow, pi, {
        isOwnerActive: () => ownerBranchIsActive(target.branchId),
      });
    }
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
    getScopedServices(scopeId).backgroundDeliveries.markEntered(event.messages);
    const currentMessages = delivery.filterContext(event.messages);
    delivery.markAutomaticDeliveriesEntered(currentMessages);
    return { messages: wakeDelivery.filterContext(currentMessages) };
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
    hostedCompletionAcker = undefined;
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
    scopedServices.backgroundDeliveries.cancelPrefix('delegate-jobs:');
    scopedServices.backgroundDeliveries.cancelPrefix('delegate-wake:');
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
