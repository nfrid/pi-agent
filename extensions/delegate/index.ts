import type {
  ExtensionAPI,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { defineExtension } from '../shared/runtime/extension';
import { createRailPanel } from '../shared/ui/rail';
import { registerDelegateBranchesTool } from './branches-tool';
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

  pi.on('session_start', (_event, ctx) => {
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
    registerDelegateTool(pi, ctx.cwd, {
      manager: jobs,
      statuses,
      getDeliveryEpoch: () => deliveryEpoch,
    });
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
    description: 'Toggle detailed subagent status',
    handler: async (_args, ctx) => {
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
