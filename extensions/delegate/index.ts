import type {
  ExtensionAPI,
  ExtensionUIContext,
  ThemeColor,
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
import {
  type BackgroundCompletionCard,
  renderBackgroundCompletion,
} from '../shared/ui/background-completion';
import { createRailPanel } from '../shared/ui/rail';
import { registerDelegateBranchesTool } from './branches-tool';
import {
  delegateRouteCount,
  fingerprintDelegateConfig,
  getDelegateSettingsPath,
  loadDelegateConfig,
} from './config';
import { DelegateJobManager, type DelegateJobSnapshot } from './jobs';
import { registerDelegateJobsTool } from './jobs-tool';
import { clearDelegateSurface, publishDelegateSurface } from './live';
import { pruneDelegateSessions } from './session';
import { DelegateStatusStore } from './status';
import {
  parseChildDelegateResultSpec,
  registerChildDelegateResultTool,
} from './structured-result';
import { registerDelegateTool } from './tool';
import { delegateToolBoundary } from './tool-boundary';
import { type DelegateRunState, getRunState } from './types';
import {
  DELEGATE_WIDGET_MAX_WIDTH,
  DELEGATE_WIDGET_MIN_WIDTH,
  formatElapsed,
  renderDelegateWidget,
} from './widget';
import { loadWorktree } from './worktree';
import { registerDelegateWorktreesCommand } from './worktrees-command';

export const DELEGATES_COMMAND_DESCRIPTION =
  'Toggle detailed subagent status or inspect delegate config';

const COMPLETION_WAVE_GRACE_MS = 5_000;
const COMPLETION_WAVE_BURST_MS = 50;
const AUTOMATIC_DELIVERY_STATE_LIMIT = 256;

type AutomaticDeliveryState = 'queued' | 'entered';

type CompletionState = Extract<
  DelegateRunState,
  'success' | 'error' | 'timed-out' | 'aborted'
>;

function completionState(job: DelegateJobSnapshot): CompletionState {
  const run = job.runs?.[0];
  const state = run ? getRunState(run) : job.state;
  if (state === 'timed-out' || state === 'aborted' || state === 'error')
    return state;
  return 'success';
}

function completionStyle(state: CompletionState): {
  icon: string;
  color: ThemeColor;
  label: string;
} {
  if (state === 'error') return { icon: '✗', color: 'error', label: 'failed' };
  if (state === 'timed-out')
    return { icon: '◷', color: 'warning', label: 'timed out' };
  if (state === 'aborted')
    return { icon: '■', color: 'warning', label: 'aborted' };
  return { icon: '✓', color: 'success', label: 'finished' };
}

function jobDuration(job: DelegateJobSnapshot): string {
  return job.settledAt
    ? formatElapsed(job.startedAt ?? job.createdAt, job.settledAt)
    : '';
}

function completionCard(
  jobs: readonly DelegateJobSnapshot[],
): BackgroundCompletionCard {
  if (jobs.length === 0)
    return {
      icon: '✓',
      color: 'success',
      title: [{ text: 'Background subagent finished', color: 'muted' }],
    };
  const states = jobs.map(completionState);
  const dominant = states.includes('error')
    ? 'error'
    : states.includes('timed-out')
      ? 'timed-out'
      : states.includes('aborted')
        ? 'aborted'
        : 'success';
  const style = completionStyle(dominant);
  const duration = formatElapsed(
    Math.min(...jobs.map((job) => job.startedAt ?? job.createdAt)),
    Math.max(...jobs.map((job) => job.settledAt ?? job.createdAt)),
  );
  const counts = (state: CompletionState) =>
    states.filter((candidate) => candidate === state).length;
  const outcome = [
    counts('success') ? `${counts('success')} succeeded` : '',
    counts('error') ? `${counts('error')} failed` : '',
    counts('timed-out') ? `${counts('timed-out')} timed out` : '',
    counts('aborted') ? `${counts('aborted')} aborted` : '',
  ].filter(Boolean);
  const title =
    jobs.length === 1
      ? [
          { text: 'Background subagent ', color: 'muted' as const },
          { text: jobs[0].name, color: 'text' as const },
          {
            text: ` · ${completionStyle(states[0]).label} · ${duration}`,
            color: 'dim' as const,
          },
        ]
      : [
          {
            text: `${jobs.length} background subagents finished`,
            color: 'text' as const,
          },
          {
            text: `${outcome.length > 1 || dominant !== 'success' ? ` · ${outcome.join(', ')}` : ''} · ${duration}`,
            color: 'dim' as const,
          },
        ];
  return {
    icon: style.icon,
    color: style.color,
    title,
    rows: jobs.map((job) => {
      const state = completionState(job);
      const row = completionStyle(state);
      const metadata = [job.id, job.route, jobDuration(job)].filter(Boolean);
      return {
        icon: row.icon,
        color: row.color,
        segments: [
          { text: job.name, color: 'text' },
          {
            text: ` · ${row.label}${metadata.length ? ` · ${metadata.join(' · ')}` : ''}`,
            color: 'dim',
          },
        ],
      };
    }),
  };
}

/** Stable registration facade; orchestration and broker commands have separate owners. */
export default defineExtension('delegate', (pi: ExtensionAPI) => {
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
  let pendingCompletions: DelegateJobSnapshot[] = [];
  // sendMessage can queue a steer while the parent is still active. Keep this
  // separate from pendingCompletions, whose wave is already flushed by then.
  const automaticDeliveryStates = new Map<string, AutomaticDeliveryState>();
  let completionTimer: NodeJS.Timeout | undefined;
  let completionFlushAt: number | undefined;
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

  const activeStatuses = () => statuses?.list() ?? [];

  const trimAutomaticDeliveryStates = () => {
    while (automaticDeliveryStates.size > AUTOMATIC_DELIVERY_STATE_LIMIT) {
      const entered = [...automaticDeliveryStates].find(
        ([, state]) => state === 'entered',
      );
      const oldest = entered ?? automaticDeliveryStates.entries().next().value;
      if (oldest) automaticDeliveryStates.delete(oldest[0]);
    }
  };

  const queueAutomaticDelivery = (jobs: readonly DelegateJobSnapshot[]) => {
    for (const job of jobs) automaticDeliveryStates.set(job.id, 'queued');
    trimAutomaticDeliveryStates();
  };

  const rollbackAutomaticDelivery = (jobs: readonly DelegateJobSnapshot[]) => {
    for (const job of jobs) {
      if (automaticDeliveryStates.get(job.id) === 'queued')
        automaticDeliveryStates.delete(job.id);
    }
  };

  const automaticDeliveryQueued = (job: DelegateJobSnapshot) =>
    automaticDeliveryStates.get(job.id) === 'queued';

  const hasQueuedAutomaticDeliveries = () =>
    [...automaticDeliveryStates.values()].some((state) => state === 'queued');

  const clearUnenteredAutomaticDeliveries = () => {
    for (const [id, state] of automaticDeliveryStates) {
      if (state === 'queued') automaticDeliveryStates.delete(id);
    }
  };

  const markAutomaticDeliveriesEntered = (messages: readonly unknown[]) => {
    for (const message of messages) {
      const candidate = message as {
        customType?: unknown;
        details?: { jobs?: unknown };
      };
      if (candidate.customType !== 'delegate-job-result') continue;
      const jobs = candidate.details?.jobs;
      if (!Array.isArray(jobs)) continue;
      for (const job of jobs) {
        const id =
          job && typeof job === 'object' && typeof job.id === 'string'
            ? job.id
            : undefined;
        if (id && automaticDeliveryStates.get(id) === 'queued')
          automaticDeliveryStates.set(id, 'entered');
      }
    }
    trimAutomaticDeliveryStates();
  };

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

  const notifyStaleCompletions = (jobs: readonly DelegateJobSnapshot[]) => {
    const ids = jobs.map((job) => job.id).join(', ');
    ui?.notify(
      `Delegate job${jobs.length === 1 ? '' : 's'} ${ids} finished on another conversation branch; use delegate_jobs peek to inspect ${jobs.length === 1 ? 'it' : 'them'}.`,
      'info',
    );
  };

  const flushCompletions = () => {
    completionTimer = undefined;
    completionFlushAt = undefined;
    if (!runtimeActive || pendingCompletions.length === 0) return;
    const queued = pendingCompletions;
    pendingCompletions = [];
    const completed = queued.filter(
      (job) => job.deliveryEpoch === deliveryEpoch,
    );
    const stale = queued.filter((job) => job.deliveryEpoch !== deliveryEpoch);
    if (stale.length > 0) notifyStaleCompletions(stale);
    if (completed.length === 0) return;
    const content = completed
      .map((job) => {
        const body =
          job.handoff ??
          job.error ??
          '(background delegate produced no result)';
        return `# Background delegate job ${job.id} (${job.name}) ${job.state}\n\n${body}`;
      })
      .join('\n\n---\n\n');
    queueAutomaticDelivery(completed);
    try {
      pi.sendMessage(
        {
          customType: 'delegate-job-result',
          content,
          display: true,
          details: { jobs: completed },
        },
        { deliverAs: 'steer', triggerTurn: true },
      );
      statuses?.jobResultEntered(completed.map((job) => job.id));
    } catch (error) {
      rollbackAutomaticDelivery(completed);
      console.error('delegate: failed to deliver background completion', error);
    }
  };

  const queueCompletion = (job: DelegateJobSnapshot) => {
    if (!runtimeActive) return;
    statuses?.settleJobs([job]);
    if (job.deliveryEpoch !== deliveryEpoch) {
      notifyStaleCompletions([job]);
      return;
    }
    pendingCompletions.push(job);
    // Give the first result a short grace period for siblings, then deliver
    // whatever is ready. A second result (or the final active job) closes the
    // wave promptly without waiting for the whole original batch.
    const delay =
      pendingCompletions.length >= 2 || jobs?.runningCount === 0
        ? COMPLETION_WAVE_BURST_MS
        : COMPLETION_WAVE_GRACE_MS;
    const flushAt = Date.now() + delay;
    if (completionFlushAt !== undefined && completionFlushAt <= flushAt) return;
    if (completionTimer) clearTimeout(completionTimer);
    completionFlushAt = flushAt;
    completionTimer = setTimeout(flushCompletions, delay);
    completionTimer.unref();
  };

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
    pendingCompletions = [];
    automaticDeliveryStates.clear();
    completionFlushAt = undefined;
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
      onSettled: queueCompletion,
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
        pendingCompletions = pendingCompletions.filter(
          (job) => job.deliveryEpoch !== deliveryEpoch || !entered.has(job.id),
        );
        statuses?.settleJobs(completed);
        statuses?.jobResultEntered(completed.map((job) => job.id));
      },
      automaticDeliveryQueued,
    );
    registerDelegateBranchesTool(pi);
    syncWidget();
  });

  pi.on('session_tree', () => {
    deliveryEpoch++;
    automaticDeliveryStates.clear();
  });
  pi.on('context', (event) => {
    // A queued steer cannot be retracted. Once it is in context, later peeks
    // intentionally return the retained full result again.
    markAutomaticDeliveriesEntered(event.messages);
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
      pendingCompletions.length > 0 || hasQueuedAutomaticDeliveries(),
      scopeId,
    );
    // A successfully queued steer prevents settlement until it enters context.
    // If the parent settles first, dispatch failed asynchronously and explicit
    // inspection must remain able to return the retained handoff.
    clearUnenteredAutomaticDeliveries();
    if (genuinelySettled) statuses?.parentSettled();
    syncWidget();
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    runtimeActive = false;
    if (completionTimer) clearTimeout(completionTimer);
    completionTimer = undefined;
    completionFlushAt = undefined;
    pendingCompletions = [];
    automaticDeliveryStates.clear();
    widget.detach();
    const closing = jobs;
    const closingStatuses = statuses;
    jobs = undefined;
    statuses = undefined;
    await closing?.dispose();
    closingStatuses?.clear();
    const closingScopeId = getSessionScopeId(ctx);
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
