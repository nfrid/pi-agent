import type {
  ExtensionAPI,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
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
import {
  DELEGATE_WIDGET_MAX_WIDTH,
  DELEGATE_WIDGET_MIN_WIDTH,
  renderDelegateWidget,
} from './widget';
import { loadWorktree } from './worktree';
import { registerDelegateWorktreesCommand } from './worktrees-command';

export const DELEGATES_COMMAND_DESCRIPTION =
  'Toggle detailed subagent status or inspect delegate config';

/** Stable registration facade; orchestration and broker commands have separate owners. */
export default defineExtension('delegate', (pi: ExtensionAPI) => {
  registerDelegateCapability();
  const isChild = process.env.PI_DELEGATE_CHILD === '1';

  if (isChild) {
    const resultSpec = parseChildDelegateResultSpec(
      process.env.PI_DELEGATE_RESULT_SCHEMA,
    );
    if (resultSpec) registerChildDelegateResultTool(pi, resultSpec);
    pi.on('tool_call', (event, ctx) => {
      const reason = delegateToolBoundary(event.toolName, event.input, ctx.cwd);
      return reason ? { block: true, reason } : undefined;
    });
    return;
  }

  let jobs: DelegateJobManager | undefined;
  let statuses: DelegateStatusStore | undefined;
  let ui: ExtensionUIContext | undefined;
  let scopeId: SessionScopeId = 'default';
  let deliveryEpoch = 0;
  let runtimeActive = false;
  let widgetDetailed = true;
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

  const delivery = createCompletionDelivery({
    pi,
    getRuntimeActive: () => runtimeActive,
    getDeliveryEpoch: () => deliveryEpoch,
    getRunningCount: () => jobs?.runningCount ?? 0,
    getStatuses: () => statuses,
    getUi: () => ui,
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
    render: (width, theme) =>
      renderDelegateWidget(activeStatuses(), widgetDetailed, width, theme),
    onError: (error) =>
      console.error('delegate: failed to update the jobs widget', error),
  });

  const syncWidget = () => widget.sync();

  pi.on('session_start', (event, ctx) => {
    const sessionScopeId = getSessionScopeId(ctx);
    if (jobs && scopeId !== 'default' && scopeId !== sessionScopeId) {
      const closingJobs = jobs;
      const closingStatuses = statuses;
      jobs = undefined;
      statuses = undefined;
      void closingJobs.dispose().then(() => closingStatuses?.clear());
    }
    if (scopeId !== 'default' && scopeId !== sessionScopeId)
      clearDelegateSurface(scopeId);
    scopeId = sessionScopeId;
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
    widgetDetailed = true;
    delivery.clearPending();
    delivery.resetAutomaticDelivery();
    delivery.clearTimer();
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
      onSettled: delivery.queueCompletion,
    });
    registerDelegateTool(
      pi,
      ctx.cwd,
      {
        manager: jobs,
        statuses,
        getDeliveryEpoch: () => deliveryEpoch,
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
      delivery.automaticDeliveryQueued,
    );
    registerDelegateBranchesTool(pi);
    syncWidget();
  });

  pi.on('session_tree', () => {
    deliveryEpoch++;
    delivery.resetAutomaticDelivery();
  });
  pi.on('context', (event) => {
    // A queued steer cannot be retracted. Once it is in context, later peeks
    // intentionally return the retained full result again.
    delivery.markAutomaticDeliveriesEntered(event.messages);
  });
  // Unlike background-terminals, this widget is not force-remounted at agent
  // boundaries: a delegate run is live across them, and tearing the component
  // down mid-run would discard the mounted render loop. A plain sync refreshes
  // the existing component in place.
  pi.on('agent_start', syncWidget);
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
    if (scopeId !== closingScopeId) return;
    runtimeActive = false;
    delivery.clearTimer();
    delivery.clearPending();
    delivery.resetAutomaticDelivery();
    widget.detach();
    const closing = jobs;
    const closingStatuses = statuses;
    jobs = undefined;
    statuses = undefined;
    await closing?.dispose();
    closingStatuses?.clear();
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
});
