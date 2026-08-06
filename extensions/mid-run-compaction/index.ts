import type {
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';

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
  return usage.tokens > threshold;
}

export default function midRunCompaction(pi: ExtensionAPI): void {
  let active = true;
  let compactionInFlight = false;
  let disabledAfterFailure = false;

  const finish = (ctx: ExtensionContext, error?: Error) => {
    compactionInFlight = false;
    // Compaction callbacks may settle after a reload or session replacement.
    // The old extension instance receives session_shutdown first; never touch
    // its session-bound ctx or pi after that point.
    if (!active) return;
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

  pi.on('session_start', () => {
    active = true;
    compactionInFlight = false;
    disabledAfterFailure = false;
  });

  pi.on('session_shutdown', () => {
    active = false;
    compactionInFlight = false;
  });

  pi.on('turn_end', (event, ctx) => {
    if (
      compactionInFlight ||
      disabledAfterFailure ||
      !shouldCompactMidRun(event, ctx)
    ) {
      return;
    }

    compactionInFlight = true;
    ctx.ui.setStatus('mid-run-compaction', 'compacting context…');
    ctx.compact({
      onComplete: () => finish(ctx),
      onError: (error) => finish(ctx, error),
    });
  });
}
