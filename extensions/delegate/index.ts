import type {
  ExtensionAPI,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { loadIsolation, scrubStaleIsolationCredentials } from './isolation';
import { DelegateJobManager, type DelegateJobSnapshot } from './jobs';
import { registerDelegateJobsTool } from './jobs-tool';
import { registerDelegatePatchCommand } from './patch-command';
import { pruneDelegateSessions } from './session';
import { DelegateStatusStore } from './status';
import { registerDelegateTool } from './tool';
import { delegateToolBoundary } from './tool-boundary';
import { renderDelegateWidget } from './widget';

const registered = new WeakSet<object>();

/** Stable registration facade; orchestration and broker commands have separate owners. */
export default function delegate(pi: ExtensionAPI) {
  if (registered.has(pi)) return;
  registered.add(pi);
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
  let widgetTimer: NodeJS.Timeout | undefined;
  let widgetRefreshTimer: NodeJS.Timeout | undefined;
  let widgetDetailed = true;
  let widgetMounted = false;
  let requestWidgetRender = () => {};

  const activeStatuses = () => statuses?.list() ?? [];

  const stopWidgetTimer = () => {
    if (widgetTimer) clearInterval(widgetTimer);
    widgetTimer = undefined;
  };

  const cancelWidgetRefresh = () => {
    if (widgetRefreshTimer) clearTimeout(widgetRefreshTimer);
    widgetRefreshTimer = undefined;
  };

  const requestWidgetRefresh = () => {
    if (widgetRefreshTimer) return;
    widgetRefreshTimer = setTimeout(() => {
      widgetRefreshTimer = undefined;
      requestWidgetRender();
    }, 16);
    widgetRefreshTimer.unref();
  };

  const syncWidget = () => {
    if (!ui || !statuses) return;
    const active = activeStatuses();
    if (active.length === 0) {
      stopWidgetTimer();
      cancelWidgetRefresh();
      requestWidgetRender = () => {};
      if (!widgetMounted) return;
      try {
        ui.setWidget('delegate-jobs', undefined);
        widgetMounted = false;
      } catch {
        // UI may already be unavailable during session teardown.
      }
      return;
    }

    if (!widgetTimer) {
      widgetTimer = setInterval(requestWidgetRefresh, 1_000);
      widgetTimer.unref();
    }
    if (widgetMounted) {
      requestWidgetRefresh();
      return;
    }

    try {
      ui.setWidget('delegate-jobs', (tui, theme) => {
        const requestRender = () => tui.requestRender();
        requestWidgetRender = requestRender;
        return {
          dispose() {
            if (requestWidgetRender === requestRender) {
              requestWidgetRender = () => {};
              widgetMounted = false;
            }
          },
          invalidate() {},
          render(width: number) {
            return renderDelegateWidget(
              activeStatuses(),
              widgetDetailed,
              width,
              theme,
            );
          },
        };
      });
      widgetMounted = true;
    } catch {
      // UI may already be unavailable during session teardown.
    }
  };

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

  scrubStaleIsolationCredentials();
  pi.on('session_start', (_event, ctx) => {
    runtimeActive = true;
    ui = ctx.hasUI ? ctx.ui : undefined;
    deliveryEpoch = 0;
    widgetDetailed = true;
    widgetMounted = false;
    requestWidgetRender = () => {};
    pendingCompletions = [];
    pruneDelegateSessions({
      isIsolationRetained: (id) => Boolean(loadIsolation(id)),
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
    syncWidget();
  });

  pi.on('session_tree', () => {
    deliveryEpoch++;
  });
  pi.on('agent_start', syncWidget);
  pi.on('agent_settled', syncWidget);
  pi.on('session_shutdown', async () => {
    runtimeActive = false;
    if (completionTimer) clearTimeout(completionTimer);
    completionTimer = undefined;
    pendingCompletions = [];
    stopWidgetTimer();
    cancelWidgetRefresh();
    requestWidgetRender = () => {};
    const closing = jobs;
    const closingStatuses = statuses;
    jobs = undefined;
    statuses = undefined;
    await closing?.dispose();
    closingStatuses?.clear();
    try {
      ui?.setWidget('delegate-jobs', undefined);
    } catch {
      // UI may already be unavailable.
    }
    widgetMounted = false;
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

  registerDelegatePatchCommand(pi);
}
