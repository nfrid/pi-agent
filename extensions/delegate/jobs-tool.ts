import { StringEnum } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import type { DelegateJobManager, DelegateJobSnapshot } from './jobs';

const Parameters = Type.Object({
  action: StringEnum(['list', 'peek', 'cancel'] as const, {
    description: 'Operation to perform',
  }),
  id: Type.Optional(Type.String({ description: 'Job ID for peek' })),
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

export function registerDelegateJobsTool(
  pi: ExtensionAPI,
  manager: DelegateJobManager,
  onResultEntered: (jobs: readonly DelegateJobSnapshot[]) => void = () => {},
  isAutomaticDeliveryQueued: (job: DelegateJobSnapshot) => boolean = () =>
    false,
): void {
  pi.registerTool<
    typeof Parameters,
    {
      action: 'list' | 'peek' | 'cancel';
      job?: DelegateJobSnapshot;
      jobs?: DelegateJobSnapshot[];
    }
  >({
    name: 'delegate_jobs',
    label: 'Delegate Jobs',
    description:
      'Inspect and cancel asynchronous delegate jobs. Completions are delivered automatically. Do not use peek merely to wait: if no independent work remains, write exactly one brief final-channel message saying you are waiting for the background delegate and will resume automatically, then end the turn without a commentary preamble or second summary. Use peek only for deliberate inspection or once when a bounded timeout changes the next action. Actions: list, peek, cancel.',
    promptSnippet: 'Inspect or cancel asynchronous delegate jobs',
    promptGuidelines: [
      'If no independent work remains, write exactly one brief final-channel message saying you are waiting for the background delegate and will resume automatically, then end the turn without a commentary preamble or second summary. Do not call delegate_jobs peek merely to wait or keep the turn open. Use peek only for deliberate inspection or once when a bounded timeout will change the next action, and never repeat it to poll.',
    ],
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
          job = await manager.materialize(job.id, ctx);
          const automaticQueued = isAutomaticDeliveryQueued(job);
          if (
            !automaticQueued &&
            job.state !== 'queued' &&
            job.state !== 'running'
          )
            onResultEntered([job]);
          return {
            content: [
              {
                type: 'text',
                text: automaticQueued
                  ? `Automatic result for ${job.id} is already queued and will enter context shortly.`
                  : result(job),
              },
            ],
            details: {
              action: 'peek',
              job,
              ...(automaticQueued ? { delivery: 'automatic-queued' } : {}),
            },
          };
        }
        case 'cancel': {
          const ids = params.ids?.map((id) => id.trim()).filter(Boolean) ?? [];
          if (ids.length === 0) throw new Error('ids is required.');
          const jobs = await manager.cancel(ids, signal, ctx);
          const automaticQueuedIds = new Set(
            jobs.filter(isAutomaticDeliveryQueued).map((job) => job.id),
          );
          onResultEntered(
            jobs.filter((job) => !automaticQueuedIds.has(job.id)),
          );
          return {
            content: [
              {
                type: 'text',
                text: jobs
                  .map((job) =>
                    automaticQueuedIds.has(job.id)
                      ? `Automatic result for ${job.id} is already queued and will enter context shortly.`
                      : result(job),
                  )
                  .join('\n\n'),
              },
            ],
            details: {
              action: 'cancel',
              jobs,
              ...(automaticQueuedIds.size > 0
                ? {
                    delivery: 'automatic-queued',
                    automaticQueuedJobIds: [...automaticQueuedIds],
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
