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
  type WakeBranch = {
    readonly key: string;
    readonly coordinator: WakeCoordinator;
    detachStore?: () => void;
  };
  const wakeBranches = new Map<string, WakeBranch>();
  let activeWake: WakeBranch | undefined;
  let wakeBranchKey = 'root';
  let nextWakeEpoch = 0;
  const wakeDelivery = createWakeDelivery({
    pi,
    getRuntimeActive: () => runtimeActive,
    getActiveCoordinator: () => activeWake?.coordinator,
  });
  registerDelegateWakeTool(pi, () => activeWake?.coordinator);
  let scopeId: SessionScopeId = 'default';
  const sessionManagerGenerations = new WeakMap<object, number>();
  let runtimeGeneration = 0;
  let deliveryEpoch = 0;
  let runtimeActive = false;
  let widgetDetailed = true;
  const sessionLeafId = (ctx: ExtensionContext): string | null | undefined => {
    const manager = ctx.sessionManager as ExtensionContext['sessionManager'] & {
      getLeafId?: () => string | null | undefined;
    };
    if (typeof manager.getLeafId === 'function') {
      const leafId = manager.getLeafId();
      return leafId === '' ? null : leafId;
    }
    const branch = manager.getBranch();
    const last = branch.at(-1) as { id?: unknown } | undefined;
    return typeof last?.id === 'string' ? last.id : undefined;
  };
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
      });
      if (persisted?.ownerSessionId === ownerSessionId)
        restoreWakeState(coordinator, ctx);
      branch = { key, coordinator };
      wakeBranches.set(key, branch);
    }
    activeWake = branch;
    branch.detachStore = attachWakeStore(branch.coordinator, pi);
    branch.coordinator.setDispatchHandler(wakeDelivery.dispatch);
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
    const closingWorkflow = workflow;
    const closingStatuses = statuses;

    // Invalidate and detach the previous generation immediately, including a
    // repeated session_start for the same session ID.
    runtimeActive = false;
    jobs = undefined;
    workflow = undefined;
    statuses = undefined;
    disposeWakeRuntime();
    delivery.clearTimer();
    delivery.clearPending();
    delivery.resetAutomaticDelivery();
    widget.detach();
    await closingWorkflow?.dispose();
    await closingJobs?.dispose();
    closingStatuses?.clear();
    const previousServices = getScopedServices(previousScopeId);
    if (previousServices.delegateWorkflow === closingWorkflow)
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
    wakeBranchKey = `${sessionScopeId}:${sessionLeafId(ctx) ?? 'root'}`;
    widgetDetailed = true;
    widget.attach(ui);
    pruneDelegateSessions({
      isWorktreeRetained: (id) => Boolean(loadWorktree(id)),
    });
    let nextStatuses: DelegateStatusStore | undefined;
    nextStatuses = new DelegateStatusStore(() => {
      syncWidget();
      if (nextStatuses) publishDelegateSurface(nextStatuses, sessionScopeId);
    });
    statuses = nextStatuses;
    publishDelegateSurface(nextStatuses, sessionScopeId);
    const scopedServices = getScopedServices(sessionScopeId);
    jobs = new DelegateJobManager({
      scopeId: sessionScopeId,
      pendingProcesses: scopedServices.pendingProcesses,
      // Coordinator-owned jobs settle through workflow terminal listeners and
      // must not also appear as legacy automatic completions.
      onSettled: (job) => {
        if (!job.attemptIdentity) delivery.queueCompletion(job);
      },
    });
    workflow = createDelegateWorkflowCoordinator({ jobs });
    scopedServices.delegateWorkflow = workflow;
    registerDelegateTool(
      pi,
      ctx.cwd,
      {
        workflow,
        manager: jobs,
        statuses,
        getDeliveryEpoch: () => deliveryEpoch,
        activateJobs: activateJobsTool,
        activateBranches: activateBranchesTool,
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
    const treeEvent = event as { newLeafId?: string | null };
    const eventLeafId = treeEvent.newLeafId === '' ? null : treeEvent.newLeafId;
    const leafId = eventLeafId === undefined ? sessionLeafId(ctx) : eventLeafId;
    // Old host shims without branch identity cannot safely distinguish a fork;
    // keep the current wake branch rather than abandoning or cross-binding it.
    if (leafId === undefined) return;
    wakeBranchKey = `${scopeId}:${leafId ?? 'root'}`;
    activateWakeBranch(ctx, wakeBranchKey);
  });
  pi.on('context', (event) => {
    // Keep the automatic-delivery marker through context entry so a later
    // peek does not replay the same settled completion.
    delivery.markAutomaticDeliveriesEntered(event.messages);
    wakeDelivery.markContextEntered(event.messages);
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
    const closingWorkflow = workflow;
    const closingStatuses = statuses;
    jobs = undefined;
    workflow = undefined;
    statuses = undefined;
    disposeWakeRuntime();
    await closingWorkflow?.dispose();
    // Workflow coordinators use this shared manager but do not own it.
    await closing?.dispose();
    closingStatuses?.clear();
    const scopedServices = getScopedServices(closingScopeId);
    if (scopedServices.delegateWorkflow === closingWorkflow)
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
