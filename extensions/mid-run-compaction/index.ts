import {
  type ExtensionAPI,
  type ExtensionContext,
  estimateTokens,
  type TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import {
  getScopedServices,
  getSessionScopeId,
  type PendingProcessAccounting,
  type SessionScopeId,
} from '../shared/runtime/scoped-services';

const MIN_HEADROOM_TOKENS = 32_768;
const MAX_CONTEXT_FRACTION = 0.85;
const CONTINUATION_MESSAGE =
  'Context was automatically compacted during the tool loop. Continue the task from where you left off. Do not wait for user input unless it is genuinely required.';

export function shouldCompactMidRun(
  event: TurnEndEvent,
  ctx: ExtensionContext,
): boolean {
  if (event.toolResults.length === 0) return false;

  const usage = ctx.getContextUsage();
  if (usage?.tokens === null || usage?.tokens === undefined) return false;

  const threshold = Math.min(
    usage.contextWindow - MIN_HEADROOM_TOKENS,
    usage.contextWindow * MAX_CONTEXT_FRACTION,
  );
  // Context usage comes from the latest assistant response, before this tool
  // batch entered the transcript. Include the finalized results so one large
  // batch cannot cross the threshold immediately before the next request.
  const completedToolResultTokens = event.toolResults.reduce(
    (total, result) => total + estimateTokens(result),
    0,
  );
  return usage.tokens + completedToolResultTokens > threshold;
}

export default function midRunCompaction(pi: ExtensionAPI): void {
  type InFlightCompaction = {
    generation: number;
    accounting: PendingProcessAccounting;
    source: object;
    settle: () => void;
  };
  let active = true;
  let generation = 0;
  let sessionOwner: object | undefined;
  let sessionScopeId: SessionScopeId | undefined;
  let compactionInFlight = false;
  let disabledAfterFailure = false;
  let inFlight: InFlightCompaction | undefined;

  const clearPending = (work = inFlight) => {
    work?.accounting.set(work.source, 0);
    work?.settle();
    if (inFlight === work) inFlight = undefined;
  };

  const finish = (
    ctx: ExtensionContext,
    work: InFlightCompaction,
    error?: Error,
  ) => {
    const ownsCurrentAttempt = inFlight === work;
    clearPending(work);
    // A late callback owns only its captured accounting registration. Never
    // let it mutate or resume a replacement session generation, and make each
    // attempt's completion callback single-use.
    if (!ownsCurrentAttempt || !active || work.generation !== generation)
      return;
    compactionInFlight = false;
    try {
      ctx.ui.setStatus('mid-run-compaction', undefined);
      if (error) {
        disabledAfterFailure = true;
        ctx.ui.notify(
          `Mid-run compaction failed; continuing without another attempt: ${error.message}`,
          'warning',
        );
      }
      pi.sendMessage(
        {
          customType: 'mid-run-compaction',
          content: CONTINUATION_MESSAGE,
          display: false,
        },
        { triggerTurn: true, deliverAs: 'followUp' },
      );
    } catch {
      // A replacement can race the callback after the active check. The new
      // extension instance owns the new session; this stale callback has no
      // valid follow-up work to perform.
    }
  };

  pi.on('session_start', (_event, ctx) => {
    const nextOwner = ctx.sessionManager ?? ctx;
    const nextScopeId = getSessionScopeId(ctx);
    if (sessionOwner !== nextOwner || sessionScopeId !== nextScopeId)
      clearPending();
    generation += 1;
    sessionOwner = nextOwner;
    sessionScopeId = nextScopeId;
    active = true;
    compactionInFlight = false;
    disabledAfterFailure = false;
  });

  pi.on('session_shutdown', (_event, ctx) => {
    const closingOwner = ctx.sessionManager ?? ctx;
    const closingScopeId = getSessionScopeId(ctx);
    if (
      (sessionOwner && sessionOwner !== closingOwner) ||
      (sessionScopeId && sessionScopeId !== closingScopeId)
    )
      return;
    clearPending();
    generation += 1;
    sessionOwner = undefined;
    sessionScopeId = undefined;
    active = false;
    compactionInFlight = false;
  });

  pi.on('turn_end', async (event, ctx) => {
    sessionOwner ??= ctx.sessionManager ?? ctx;
    sessionScopeId ??= getSessionScopeId(ctx);
    if (
      compactionInFlight ||
      disabledAfterFailure ||
      !shouldCompactMidRun(event, ctx)
    ) {
      return;
    }

    compactionInFlight = true;
    const accounting = getScopedServices(
      getSessionScopeId(ctx),
    ).pendingProcesses;
    let resolveWait: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    let settled = false;
    const work: InFlightCompaction = {
      generation,
      accounting,
      source: {},
      settle: () => {
        if (settled) return;
        settled = true;
        resolveWait();
      },
    };
    inFlight = work;
    accounting.set(work.source, 1);
    try {
      ctx.ui.setStatus('mid-run-compaction', 'compacting context…');
      ctx.compact({
        onComplete: () => finish(ctx, work),
        onError: (error) => finish(ctx, work, error),
      });
    } catch (error) {
      finish(
        ctx,
        work,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    // Extension handlers are awaited by Pi. Hold this boundary until the
    // compaction callback completes so the automatic tool-loop request cannot
    // race ahead with the oversized pre-compaction context.
    await wait;
  });
}
