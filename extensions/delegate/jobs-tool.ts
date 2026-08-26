import { StringEnum } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import type { AutomaticDeliveryState } from './completion-delivery';
import type { DelegateJobManager, DelegateJobSnapshot } from './jobs';
import type {
  DelegateWorkflowAttemptSnapshot,
  DelegateWorkflowCoordinator,
} from './workflow-coordinator';

const Parameters = Type.Object({
  action: StringEnum(['list', 'status', 'feedback', 'cancel'] as const, {
    description:
      'list shows tracked jobs; status shows bounded metadata; feedback sends corrective guidance to a queued or running job; cancel stops one or more jobs. Results arrive through eager delivery or delegate_gate; use status rather than polling.',
  }),
  id: Type.Optional(
    Type.String({
      description: 'Logical attempt or adapter ID for status/feedback',
    }),
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
  // Legacy wait_seconds is accepted by old callers but omitted from schema.
});

const DELEGATE_JOBS_DESCRIPTION =
  'Inspect bounded metadata, steer, and cancel asynchronous delegate workflow attempts. Results arrive eagerly unless held by delegate_gate. Use feedback with one bounded message to steer a running child; this tool never polls or consumes result bodies.';

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function summary(
  job: Pick<DelegateJobSnapshot, 'id' | 'state' | 'name'>,
): string {
  return `${job.id} ${job.state} — ${job.name}`;
}

type DelegateAttemptMetadata = Pick<
  DelegateWorkflowAttemptSnapshot,
  | 'logicalId'
  | 'ordinal'
  | 'identity'
  | 'state'
  | 'dependencies'
  | 'waitingFor'
  | 'createdAt'
  | 'scheduledAt'
  | 'queuedAt'
  | 'startedAt'
  | 'settledAt'
  | 'route'
  | 'allowWrites'
  | 'reason'
>;

function attemptSummary(attempt: DelegateAttemptMetadata): string {
  const waiting = attempt.waitingFor?.length
    ? `, waiting for ${attempt.waitingFor.join(', ')}`
    : '';
  const reason = attempt.reason ? ` — ${attempt.reason}` : '';
  return `${attempt.identity} ${attempt.state}${waiting}${reason}`;
}

function compactAttempt(
  attempt: DelegateWorkflowAttemptSnapshot,
): DelegateAttemptMetadata {
  return {
    logicalId: attempt.logicalId,
    ordinal: attempt.ordinal,
    identity: attempt.identity,
    state: attempt.state,
    dependencies: attempt.dependencies,
    waitingFor: attempt.waitingFor,
    createdAt: attempt.createdAt,
    scheduledAt: attempt.scheduledAt,
    queuedAt: attempt.queuedAt,
    startedAt: attempt.startedAt,
    settledAt: attempt.settledAt,
    route: attempt.route,
    allowWrites: attempt.allowWrites,
    reason: attempt.reason,
  };
}

function feedbackText(
  id: string,
  delivery: 'queued' | 'settled' | 'unavailable',
): string {
  return delivery === 'queued'
    ? `Feedback queued for ${id}.`
    : delivery === 'settled'
      ? `Feedback was not delivered because ${id} is already settled.`
      : `Feedback could not be queued for ${id}.`;
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

type DelegateJobMetadata = Pick<
  DelegateJobSnapshot,
  | 'id'
  | 'name'
  | 'mode'
  | 'state'
  | 'createdAt'
  | 'startedAt'
  | 'settledAt'
  | 'deliveryEpoch'
  | 'route'
  | 'allowWrites'
  | 'logicalId'
  | 'attemptIdentity'
>;

function compactJob(job: DelegateJobSnapshot): DelegateJobMetadata {
  return {
    id: job.id,
    name: job.name,
    mode: job.mode,
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    settledAt: job.settledAt,
    deliveryEpoch: job.deliveryEpoch,
    route: job.route,
    allowWrites: job.allowWrites,
    logicalId: job.logicalId,
    attemptIdentity: job.attemptIdentity,
  };
}

export function registerDelegateJobsTool(
  pi: ExtensionAPI,
  manager: DelegateJobManager,
  onResultEntered: (jobs: readonly DelegateJobSnapshot[]) => void = () => {},
  getAutomaticDeliveryState: (
    job: DelegateJobSnapshot,
  ) => AutomaticDeliveryState | undefined = () => undefined,
  workflow?: DelegateWorkflowCoordinator,
  getWorkflow?: () => DelegateWorkflowCoordinator | undefined,
): void {
  pi.registerTool<
    typeof Parameters,
    {
      action: 'list' | 'status' | 'feedback' | 'cancel' | 'peek';
      job?: DelegateJobSnapshot | DelegateJobMetadata;
      jobs?: Array<DelegateJobSnapshot | DelegateJobMetadata>;
      attempt?: DelegateAttemptMetadata;
      attempts?: DelegateAttemptMetadata[];
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
      const request = params as typeof params & { wait_seconds?: number };
      const activeWorkflow = getWorkflow?.() ?? workflow;
      const action = (params as { action: string }).action;
      switch (action) {
        case 'list': {
          const jobs = manager
            .list(ctx)
            .filter((job) => !job.attemptIdentity)
            .map(compactJob);
          const attempts = activeWorkflow?.list().map(compactAttempt) ?? [];
          return {
            content: [
              {
                type: 'text',
                text:
                  [...attempts.map(attemptSummary), ...jobs.map(summary)].join(
                    '\n',
                  ) || 'No delegate workflow attempts.',
              },
            ],
            details: { action: 'list', jobs, attempts },
          };
        }
        case 'status': {
          const id = requireText(params.id, 'id');
          const attempt = activeWorkflow?.get(id);
          if (attempt) {
            return {
              content: [{ type: 'text', text: attemptSummary(attempt) }],
              details: { action: 'status', attempt: compactAttempt(attempt) },
            };
          }
          const job = manager.get(id, ctx);
          if (!job) throw new Error(`Unknown delegate attempt or job "${id}".`);
          return {
            content: [{ type: 'text', text: summary(job) }],
            details: { action: 'status', job: compactJob(job) },
          };
        }
        case 'peek': {
          let job = await manager.peek(
            requireText(params.id, 'id'),
            (request.wait_seconds ?? 0) * 1000,
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
          const id = requireText(params.id, 'id');
          const attempt = activeWorkflow?.get(id);
          if (attempt) {
            if (!attempt.jobId)
              return {
                content: [
                  {
                    type: 'text',
                    text: `Feedback could not be queued for ${attempt.identity}; it is ${attempt.state}.`,
                  },
                ],
                details: {
                  action: 'feedback',
                  attempt: compactAttempt(attempt),
                  delivery: 'unavailable',
                },
              };
            const feedback = manager.sendFeedback(
              attempt.jobId,
              requireText(params.message, 'message'),
              ctx,
            );
            const current = activeWorkflow?.get(attempt.identity);
            return {
              content: [
                {
                  type: 'text',
                  text: feedbackText(attempt.identity, feedback.delivery),
                },
              ],
              details: {
                action: 'feedback',
                attempt: current ? compactAttempt(current) : undefined,
                delivery: feedback.delivery,
              },
            };
          }
          const feedback = manager.sendFeedback(
            id,
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
          const logicalIds = ids.filter((id) => activeWorkflow?.get(id));
          const adapterIds = ids.filter((id) => !logicalIds.includes(id));
          const logicalAttempts = activeWorkflow
            ? await activeWorkflow.cancel(logicalIds)
            : [];
          const jobs = adapterIds.length
            ? await manager.cancel(adapterIds, signal, ctx)
            : [];
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
          const cancelled = [
            ...logicalAttempts.map(attemptSummary),
            ...jobs.map((job) => {
              const automatic = automaticJobs.find(
                (item) => item.job.id === job.id,
              );
              return automatic
                ? automaticDeliveryStatus(job, automatic.state)
                : `${job.id} ${job.state}`;
            }),
          ];
          return {
            content: [{ type: 'text', text: cancelled.join('\n') }],
            details: {
              action: 'cancel',
              attempts: logicalAttempts.map(compactAttempt),
              jobs: jobs.map(compactJob),
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
        default:
          throw new Error(`Unknown delegate_jobs action "${action}".`);
      }
    },
    renderCall(args, theme, context) {
      const action = String(args.action ?? '');
      const title =
        theme.fg('toolTitle', theme.bold('delegate_jobs')) +
        (action ? ` ${theme.fg('muted', action)}` : '');
      if (action === 'peek') {
        const waitSeconds = (args as { wait_seconds?: number }).wait_seconds;
        const wait = waitSeconds
          ? theme.fg('dim', ` · wait ${waitSeconds}s`)
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

      if (details.action === 'status' && details.attempt) {
        return new Text(
          theme.fg(
            details.attempt.state === 'error' ||
              details.attempt.state === 'blocked'
              ? 'error'
              : details.attempt.state === 'success'
                ? 'success'
                : 'warning',
            `${details.attempt.identity} ${details.attempt.state}`,
          ),
          0,
          0,
        );
      }

      if (details.action === 'status' && details.job) {
        const display = stateDisplay(details.job.state);
        return new Text(
          theme.fg(
            display.color,
            `${display.icon} ${details.job.id} ${details.job.state}`,
          ),
          0,
          0,
        );
      }

      if (details.action === 'feedback' && details.attempt) {
        return new Text(
          theme.fg(
            'muted',
            `${details.attempt.identity} ${details.delivery ?? 'unavailable'}`,
          ),
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
        const job = details.job as DelegateJobSnapshot;
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
