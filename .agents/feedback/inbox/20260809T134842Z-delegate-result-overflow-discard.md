# HF-20260809: Delegate result overflow discards the entire diagnosis

- **Status:** new
- **Observed date:** 2026-08-09
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Read-only diagnosis of a bounded dashboard chat-switch scrolling bug
- **Harness component:** Delegate result transport and continuation handling
- **Route / attempt / outcome:** `luna-xhigh`; initial run and a constrained continuation both ended without a usable result
- **Observed cost / rework:** Two delegate attempts were lost and the parent had to diagnose the issue directly
- **Recurrence / confidence:** Observed twice in one delegated task; high confidence in the transport failure
- **Ticket:** —

## Behavior

A delegate run generated a JSON event larger than the 1,048,576-byte limit. The harness discarded the entire event and returned no conclusion. Continuing the same delegate with an explicit request for at most 300 words and no logs or file dumps again ended aborted without a result.

## Impact

An otherwise bounded investigation can consume multiple attempts while returning no recoverable findings. The parent cannot inspect a truncated result or artifact and must repeat the diagnosis.

## Evidence

- The first attempt reported: `Delegate JSON event exceeded 1048576 bytes and was discarded.`
- The continuation explicitly constrained output to a concise root cause, a few code references, and a short fix/test plan.
- The continuation still returned `Outcome: (not reported)` and `Failure: This operation was aborted`.
- No files were changed, so there was no branch diff from which to recover the analysis.

## Smallest improvement

When delegate output exceeds the event limit, retain the full payload in an artifact and return a bounded, valid completion envelope instead of discarding the event. At minimum, return a truncated conclusion plus the artifact handle and an explicit overflow status.
