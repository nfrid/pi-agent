import { StringEnum } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import type { AutomaticDeliveryState } from './completion-delivery';
import type { DelegateJobManager, DelegateJobSnapshot } from './jobs';

const Parameters = Type.Object({
  action: StringEnum(['list', 'peek', 'feedback', 'cancel'] as const, {
    description:
      'list shows tracked jobs; peek inspects one job and can wait briefly; feedback sends corrective guidance to a queued or running job; cancel stops one or more jobs.',
  }),
  id: Type.Optional(
    Type.String({ description: 'Job ID for peek or feedback' }),
  ),
  message: Type.Optional(
    Type.String({
      maxLength: 4096,
      description:
        'Bounded feedback delivered at the child’s next safe checkpoint',
    }),
  ),
  ids: Type.Optional(
    Type.Array(Type.String(), { description: 'Job IDs for cancel' }),
  ),
  wait_seconds: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 120,
      description: 'For peek, wait up to this long for settlement',
    }),
  ),
});

const DELEGATE_JOBS_DESCRIPTION =
  'Inspect, steer, and cancel asynchronous delegate jobs. Completions are delivered automatically. Use feedback with one bounded message to steer a running child at its next safe checkpoint; a settled job reports that feedback was not delivered. Use peek for deliberate inspection, not polling.';

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function summary(job: DelegateJobSnapshot): string {
  return `${job.id} ${job.state} — ${job.name}`;
}

function resultText(
  content: ReadonlyArray<{ type: string; text?: string }>,
): string {
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function stateDisplay(state: DelegateJobSnapshot['state']): {
  icon: string;
  color: 'success' | 'error' | 'warning' | 'muted';
} {
  if (state === 'success') return { icon: '✓', color: 'success' };
  if (state === 'error') return { icon: '✗', color: 'error' };
  if (state === 'aborted') return { icon: '■', color: 'muted' };
  return { icon: '●', color: 'warning' };
}

function result(job: DelegateJobSnapshot): string {
  if (job.handoff)
    return `Background delegate job ${job.id} (${job.name}) ${job.state}\n\n${job.handoff}`;
  if (job.error)
    return `Background delegate job ${job.id} (${job.name}) ${job.state}: ${job.error}`;
  return `${summary(job)}\nCompletion will be delivered automatically.`;
}

function automaticDeliveryStatus(
  job: DelegateJobSnapshot,
  state: AutomaticDeliveryState,
): string {
  return state === 'queued'
    ? `Automatic result for ${job.id} is already queued and will enter context shortly.`
    : `Automatic result for ${job.id} was already delivered; no duplicate completion is returned.`;
}

function compactJob(job: DelegateJobSnapshot): DelegateJobSnapshot {
  return {
    id: job.id,
    name: job.name,
    mode: job.mode,
    state: job.state,
    // The already-delivered response is a status, not another task replay.
    tasks: [],
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    settledAt: job.settledAt,
    deliveryEpoch: job.deliveryEpoch,
    route: job.route,
    allowWrites: job.allowWrites,
  };
}

export function registerDelegateJobsTool(
  pi: ExtensionAPI,
  manager: DelegateJobManager,
  onResultEntered: (jobs: readonly DelegateJobSnapshot[]) => void = () => {},
  getAutomaticDeliveryState: (
    job: DelegateJobSnapshot,
  ) => AutomaticDeliveryState | undefined = () => undefined,
): void {
  pi.registerTool<
    typeof Parameters,
    {
      action: 'list' | 'peek' | 'feedback' | 'cancel';
      job?: DelegateJobSnapshot;
      jobs?: DelegateJobSnapshot[];
      delivery?:
        | 'queued'
        | 'settled'
        | 'unavailable'
        | 'automatic-queued'
        | 'automatic-delivered';
    }
  >({
    name: 'delegate_jobs',
    label: 'Delegate Jobs',
    description: DELEGATE_JOBS_DESCRIPTION,
    parameters: Parameters,
    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      switch (params.action) {
        case 'list': {
          const jobs = manager.list(ctx);
          return {
            content: [
              {
                type: 'text',
                text:
                  jobs.length > 0
                    ? jobs.map(summary).join('\n')
                    : 'No background delegate jobs.',
              },
            ],
            details: { action: 'list', jobs },
          };
        }
        case 'peek': {
          let job = await manager.peek(
            requireText(params.id, 'id'),
            (params.wait_seconds ?? 0) * 1000,
            signal,
            ctx,
          );
          const automaticDelivery = getAutomaticDeliveryState(job);
          if (automaticDelivery) {
            return {
              content: [
                {
                  type: 'text',
                  text: automaticDeliveryStatus(job, automaticDelivery),
                },
              ],
              details: {
                action: 'peek',
                job: compactJob(job),
                delivery:
                  automaticDelivery === 'queued'
                    ? 'automatic-queued'
                    : 'automatic-delivered',
              },
            };
          }
          job = await manager.materialize(job.id, ctx);
          if (job.state !== 'queued' && job.state !== 'running')
            onResultEntered([job]);
          return {
            content: [{ type: 'text', text: result(job) }],
            details: { action: 'peek', job },
          };
        }
        case 'feedback': {
          const feedback = manager.sendFeedback(
            requireText(params.id, 'id'),
            requireText(params.message, 'message'),
            ctx,
          );
          const text =
            feedback.delivery === 'queued'
              ? `Feedback queued for ${feedback.job.id}; it will be presented at the child’s next safe checkpoint.`
              : feedback.delivery === 'settled'
                ? `Feedback was not delivered because ${feedback.job.id} is already settled; use a continuation if it still needs correction.`
                : `Feedback could not be queued for ${feedback.job.id}; use a continuation if it still needs correction.`;
          return {
            content: [{ type: 'text', text }],
            details: {
              action: 'feedback',
              job: feedback.job,
              delivery: feedback.delivery,
            },
          };
        }
        case 'cancel': {
          const ids = params.ids?.map((id) => id.trim()).filter(Boolean) ?? [];
          if (ids.length === 0) throw new Error('ids is required.');
          const jobs = await manager.cancel(ids, signal, ctx);
          const automaticJobs = jobs
            .map((job) => ({ job, state: getAutomaticDeliveryState(job) }))
            .filter(
              (
                item,
              ): item is {
                job: DelegateJobSnapshot;
                state: AutomaticDeliveryState;
              } => item.state !== undefined,
            );
          const automaticIds = new Set(automaticJobs.map(({ job }) => job.id));
          const queuedIds = automaticJobs
            .filter(({ state }) => state === 'queued')
            .map(({ job }) => job.id);
          const deliveredIds = automaticJobs
            .filter(({ state }) => state === 'entered')
            .map(({ job }) => job.id);
          onResultEntered(jobs.filter((job) => !automaticIds.has(job.id)));
          return {
            content: [
              {
                type: 'text',
                text: jobs
                  .map((job) => {
                    const automatic = automaticJobs.find(
                      (item) => item.job.id === job.id,
                    );
                    return automatic
                      ? automaticDeliveryStatus(job, automatic.state)
                      : result(job);
                  })
                  .join('\n\n'),
              },
            ],
            details: {
              action: 'cancel',
              jobs: jobs.map((job) =>
                automaticIds.has(job.id) ? compactJob(job) : job,
              ),
              ...(automaticIds.size > 0
                ? {
                    delivery:
                      queuedIds.length > 0
                        ? 'automatic-queued'
                        : 'automatic-delivered',
                    ...(queuedIds.length > 0
                      ? { automaticQueuedJobIds: queuedIds }
                      : {}),
                    ...(deliveredIds.length > 0
                      ? { automaticDeliveredJobIds: deliveredIds }
                      : {}),
                  }
                : {}),
            },
          };
        }
      }
    },
    renderCall(args, theme, context) {
      const action = args.action ?? '';
      const title =
        theme.fg('toolTitle', theme.bold('delegate_jobs')) +
        (action ? ` ${theme.fg('muted', action)}` : '');
      if (action === 'peek') {
        const wait = args.wait_seconds
          ? theme.fg('dim', ` · wait ${args.wait_seconds}s`)
          : '';
        return new Text(
          `${title} ${theme.fg('accent', args.id ?? '?')}${wait}`,
          0,
          0,
        );
      }
      if (action === 'feedback') {
        return new Text(`${title} ${theme.fg('accent', args.id ?? '?')}`, 0, 0);
      }
      if (action === 'cancel') {
        const ids = args.ids ?? [];
        const visible = context?.expanded ? ids : ids.slice(0, 3);
        const suffix =
          !context?.expanded && ids.length > visible.length
            ? theme.fg('dim', ` +${ids.length - visible.length}`)
            : '';
        return new Text(
          `${title} ${visible.map((id) => theme.fg('accent', id)).join(', ')}${suffix}`,
          0,
          0,
        );
      }
      return new Text(title, 0, 0);
    },
    renderResult(toolResult, { expanded }, theme) {
      const text = resultText(toolResult.content);
      if (expanded) return new Text(text, 0, 0);
      const details = toolResult.details;
      if (!details)
        return new Text(
          theme.fg('error', truncateToWidth(text, 100, '…')),
          0,
          0,
        );

      if (details.action === 'list') {
        const listed = details.jobs ?? [];
        const running = listed.filter(
          (job) => job.state === 'queued' || job.state === 'running',
        ).length;
        const failed = listed.filter((job) => job.state === 'error').length;
        return new Text(
          theme.fg('muted', `• ${listed.length} tracked`) +
            theme.fg(running > 0 ? 'warning' : 'dim', ` · ${running} running`) +
            (failed > 0 ? theme.fg('error', ` · ${failed} failed`) : ''),
          0,
          0,
        );
      }

      if (details.action === 'feedback' && details.job) {
        const display = stateDisplay(details.job.state);
        const delivery = details.delivery ?? 'unavailable';
        return new Text(
          `${theme.fg(display.color, `${display.icon} ${details.job.id} ${delivery}`)}`,
          0,
          0,
        );
      }

      if (details.action === 'peek' && details.job) {
        const job = details.job;
        const display = stateDisplay(job.state);
        const preview =
          job.handoff ?? job.error ?? job.tasks[0] ?? 'Waiting for subagent';
        return new Text(
          `${theme.fg(display.color, `${display.icon} ${job.id} ${job.state}`)}\n${theme.fg('dim', truncateToWidth(preview.replace(/\s+/g, ' ').trim(), 120, '…'))}`,
          0,
          0,
        );
      }

      const affected = details.jobs ?? [];
      const statuses = affected
        .map((job) => {
          const display = stateDisplay(job.state);
          return theme.fg(
            display.color,
            `${display.icon} ${job.id} ${job.state}`,
          );
        })
        .join(theme.fg('dim', ' · '));
      return new Text(
        statuses || theme.fg('muted', truncateToWidth(text, 100, '…')),
        0,
        0,
      );
    },
  });
}
