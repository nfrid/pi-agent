import type { ExtensionAPI, ThemeColor } from '@earendil-works/pi-coding-agent';
import {
  type BackgroundCompletionCard,
  renderBackgroundCompletion,
} from '../shared/ui/background-completion';
import type { DelegateJobSnapshot } from './jobs';
import type { DelegateStatusStore } from './status';
import { type DelegateRunState, getRunState } from './types';
import { formatElapsed } from './widget';

/** Short coalescing window; never hold the first completion for seconds. */
export const COMPLETION_WAVE_BURST_MS = 50;
/** Retained export for consumers that named the former first-wave grace. */
export const COMPLETION_WAVE_GRACE_MS = COMPLETION_WAVE_BURST_MS;
export const AUTOMATIC_DELIVERY_STATE_LIMIT = 256;

export type AutomaticDeliveryState = 'queued' | 'entered';

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

export function completionCard(
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

export interface CompletionDeliveryController {
  readonly queueCompletion: (job: DelegateJobSnapshot) => void;
  readonly flushCompletions: () => void;
  readonly clearPending: () => void;
  readonly clearTimer: () => void;
  readonly resetAutomaticDelivery: () => void;
  readonly clearUnenteredAutomaticDeliveries: () => void;
  readonly markAutomaticDeliveriesEntered: (
    messages: readonly unknown[],
  ) => void;
  readonly hasQueuedAutomaticDeliveries: () => boolean;
  readonly automaticDeliveryState: (
    job: DelegateJobSnapshot,
  ) => AutomaticDeliveryState | undefined;
  readonly pendingCount: () => number;
  readonly filterPending: (keep: (job: DelegateJobSnapshot) => boolean) => void;
}

export function createCompletionDelivery(options: {
  pi: ExtensionAPI;
  getRuntimeActive: () => boolean;
  getDeliveryEpoch: () => number;
  getRunningCount: () => number;
  getStatuses: () => DelegateStatusStore | undefined;
  getUi: () => { notify(message: string, level: 'info'): void } | undefined;
  getPaused?: () => boolean;
}): CompletionDeliveryController {
  let pendingCompletions: DelegateJobSnapshot[] = [];
  const automaticDeliveryStates = new Map<string, AutomaticDeliveryState>();
  let completionTimer: NodeJS.Timeout | undefined;
  let completionFlushAt: number | undefined;

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

  const notifyStaleCompletions = (jobs: readonly DelegateJobSnapshot[]) => {
    const ids = jobs.map((job) => job.id).join(', ');
    options
      .getUi()
      ?.notify(
        `Delegate job${jobs.length === 1 ? '' : 's'} ${ids} finished on another conversation branch; use delegate_jobs peek to inspect ${jobs.length === 1 ? 'it' : 'them'}.`,
        'info',
      );
  };

  const flushCompletions = () => {
    completionTimer = undefined;
    completionFlushAt = undefined;
    if (
      !options.getRuntimeActive() ||
      pendingCompletions.length === 0 ||
      options.getPaused?.()
    )
      return;
    const queued = pendingCompletions;
    pendingCompletions = [];
    const deliveryEpoch = options.getDeliveryEpoch();
    const completed = queued.filter(
      (job) => job.deliveryEpoch === deliveryEpoch,
    );
    const stale = queued.filter((job) => job.deliveryEpoch !== deliveryEpoch);
    if (stale.length > 0) notifyStaleCompletions(stale);
    if (completed.length === 0) return;
    const completionRuns = completed.flatMap((job) => job.runs ?? []);
    let completionRunIndex = 0;
    const detailJobs = completed.map((job) => {
      const runs = job.runs?.flatMap(() => {
        const run = completionRuns[completionRunIndex++];
        return run ? [run] : [];
      });
      return { ...job, ...(runs ? { runs } : {}) };
    });
    const dedupeKey = completed
      .map((job) => job.id)
      .sort()
      .join(',');
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
      options.pi.sendMessage(
        {
          customType: 'delegate-job-result',
          content,
          display: true,
          details: { dedupeKey, jobs: detailJobs },
        },
        { deliverAs: 'steer', triggerTurn: true },
      );
      options.getStatuses()?.jobResultEntered(completed.map((job) => job.id));
    } catch (error) {
      rollbackAutomaticDelivery(completed);
      console.error('delegate: failed to deliver background completion', error);
    }
  };

  const queueCompletion = (job: DelegateJobSnapshot) => {
    if (!options.getRuntimeActive()) return;
    // Settlement is normally idempotent, but delivery can also be retried
    // around a branch/session boundary. Do not enqueue a second copy of the
    // same stable job ID while the first copy is pending or already accepted.
    if (
      pendingCompletions.some((pending) => pending.id === job.id) ||
      automaticDeliveryStates.has(job.id)
    )
      return;
    options.getStatuses()?.settleJobs([job]);
    if (job.deliveryEpoch !== options.getDeliveryEpoch()) {
      notifyStaleCompletions([job]);
      return;
    }
    pendingCompletions.push(job);
    // Coalesce completions that land in the same event-loop burst, but never
    // make the first result wait for a long sibling grace period. Later waves
    // retain the same stable-ID deduplication above.
    const flushAt = Date.now() + COMPLETION_WAVE_BURST_MS;
    if (completionFlushAt !== undefined && completionFlushAt <= flushAt) return;
    if (completionTimer) clearTimeout(completionTimer);
    completionFlushAt = flushAt;
    completionTimer = setTimeout(flushCompletions, COMPLETION_WAVE_BURST_MS);
    completionTimer.unref();
  };

  return {
    queueCompletion,
    flushCompletions,
    clearPending: () => {
      pendingCompletions = [];
    },
    clearTimer: () => {
      if (completionTimer) clearTimeout(completionTimer);
      completionTimer = undefined;
      completionFlushAt = undefined;
    },
    resetAutomaticDelivery: () => {
      automaticDeliveryStates.clear();
    },
    clearUnenteredAutomaticDeliveries: () => {
      for (const [id, state] of automaticDeliveryStates) {
        if (state === 'queued') automaticDeliveryStates.delete(id);
      }
    },
    markAutomaticDeliveriesEntered: (messages) => {
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
    },
    hasQueuedAutomaticDeliveries: () =>
      [...automaticDeliveryStates.values()].some((state) => state === 'queued'),
    automaticDeliveryState: (job) => automaticDeliveryStates.get(job.id),
    pendingCount: () => pendingCompletions.length,
    filterPending: (keep) => {
      pendingCompletions = pendingCompletions.filter(keep);
    },
  };
}

export { renderBackgroundCompletion };
