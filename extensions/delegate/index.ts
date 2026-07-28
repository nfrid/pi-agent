import type {
  ExtensionAPI,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { defineExtension } from '../shared/runtime/extension';
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
import { pruneDelegateSessions } from './session';
import { DelegateStatusStore } from './status';
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
  const isChild = process.env.PI_DELEGATE_CHILD === '1';

  if (isChild) {
    pi.on('tool_call', (event, ctx) => {
      const reason = delegateToolBoundary(event.toolName, event.input, ctx.cwd);
      return reason ? { block: true, reason } : undefined;
    });
    return;
  }

  let jobs: DelegateJobManager | undefined;
  let statuses: DelegateStatusStore | undefined;
  let ui: ExtensionUIContext | undefined;
  let deliveryEpoch = 0;
  let runtimeActive = false;
  let pendingCompletions: DelegateJobSnapshot[] = [];
  let completionTimer: NodeJS.Timeout | undefined;
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

  const notifyStaleCompletion = (job: DelegateJobSnapshot) => {
    ui?.notify(
      `Delegate job ${job.id} finished on another conversation branch; use delegate_jobs peek to inspect it.`,
      'info',
    );
  };

  const flushCompletions = () => {
    completionTimer = undefined;
    if (!runtimeActive || pendingCompletions.length === 0) return;
    const queued = pendingCompletions;
    pendingCompletions = [];
    const completed = queued.filter(
      (job) => job.deliveryEpoch === deliveryEpoch,
    );
    for (const job of queued)
      if (job.deliveryEpoch !== deliveryEpoch) notifyStaleCompletion(job);
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
    } catch (error) {
      console.error('delegate: failed to deliver background completion', error);
    }
  };

  const queueCompletion = (job: DelegateJobSnapshot) => {
    if (!runtimeActive) return;
    if (job.deliveryEpoch !== deliveryEpoch) {
      notifyStaleCompletion(job);
      return;
    }
    pendingCompletions.push(job);
    if (completionTimer) return;
    completionTimer = setTimeout(flushCompletions, 50);
    completionTimer.unref();
  };

  pi.on('session_start', (event, ctx) => {
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
    widget.attach(ui);
    pruneDelegateSessions({
      isWorktreeRetained: (id) => Boolean(loadWorktree(id)),
    });
    statuses = new DelegateStatusStore(syncWidget);
    jobs = new DelegateJobManager({
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
    registerDelegateJobsTool(pi, jobs);
    registerDelegateBranchesTool(pi);
    syncWidget();
  });

  pi.on('session_tree', () => {
    deliveryEpoch++;
  });
  // Unlike background-terminals, this widget is not force-remounted at agent
  // boundaries: a delegate run is live across them, and tearing the component
  // down mid-run would discard the mounted render loop. A plain sync refreshes
  // the existing component in place.
  pi.on('agent_start', syncWidget);
  pi.on('agent_settled', syncWidget);
  pi.on('session_shutdown', async () => {
    runtimeActive = false;
    if (completionTimer) clearTimeout(completionTimer);
    completionTimer = undefined;
    pendingCompletions = [];
    widget.detach();
    const closing = jobs;
    const closingStatuses = statuses;
    jobs = undefined;
    statuses = undefined;
    await closing?.dispose();
    closingStatuses?.clear();
    ui = undefined;
  });

  pi.registerMessageRenderer(
    'delegate-job-result',
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        jobs?: DelegateJobSnapshot[];
      };
      const completed = details.jobs ?? [];
      const failed = completed.some((job) => job.state === 'error');
      const aborted = completed.some((job) => job.state === 'aborted');
      const color = failed ? 'error' : aborted ? 'warning' : 'success';
      const marker = failed ? '✗ ' : aborted ? '■ ' : '✓ ';
      const content =
        typeof message.content === 'string' ? message.content : '';
      return new Text(
        theme.fg(color, marker) +
          theme.fg(
            'muted',
            expanded
              ? content
              : truncateToWidth(content.replace(/\s+/g, ' ').trim(), 140, '…'),
          ),
        0,
        0,
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
