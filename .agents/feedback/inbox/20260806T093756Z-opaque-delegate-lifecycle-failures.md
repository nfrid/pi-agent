# HF-20260806: Delegate lifecycle failures lack actionable diagnostics

- **Status:** new
- **Observed date:** 2026-08-06
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Parallel research and local forensic analysis for an OrbStack/Karing networking regression.
- **Harness component:** Delegate lifecycle and result reporting
- **Route / attempt / outcome:** Two `luna-xhigh` read-only research attempts were exercised. One returned `Status: error` with only a truncated runner exception; a later focused attempt returned `Status: aborted` with no reason or outcome.
- **Observed cost / rework:** The parent could not distinguish infrastructure failure, cancellation, task error, or retryability, and repeated the research manually.
- **Recurrence / confidence:** Observed twice in one session through different delegate calls; high confidence in the reporting gap.
- **Ticket:** —

## Behavior

Failed or aborted delegates can return no actionable failure classification. In one case the only detail ended in a truncated internal runner exception; in another the result stated only that the task was aborted.

## Impact

The parent cannot decide whether to continue the same delegate, retry with another route, adjust the task, or investigate harness infrastructure. This wastes the context-saving benefit of delegation and encourages duplicate manual work.

## Evidence

- A parallel read-only research delegate returned `Status: error`, no outcome or conclusion, and a failure string truncated inside the extension runner.
- A later read-only Karing-control research delegate returned `Status: aborted`, no outcome or conclusion, and no abort cause.
- Both tasks matched the route's bounded background research use case; the issue was lifecycle reporting rather than route selection.

## Smallest improvement

Always return a stable lifecycle reason code and one complete actionable diagnostic for errored or aborted delegates, plus whether the continuation is retryable and retains usable context.
