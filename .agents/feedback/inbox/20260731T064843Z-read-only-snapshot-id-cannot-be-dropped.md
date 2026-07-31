# HF-20260731: Displayed read-only snapshot ID cannot be dropped

- **Status:** duplicate
- **Observed date:** 2026-07-31
- **Source cwd/repo:** `/Users/nfrid/.pi/agent` (local Pi agent configuration repository)
- **Task shape:** Independent read-only review of a localized TypeScript change, followed by snapshot cleanup
- **Harness component:** `delegate` completion metadata and `delegate_branches drop`
- **Route / attempt / outcome:** `luna-high`, read-only worktree isolation, successful review; cleanup with the displayed snapshot ID failed
- **Observed cost / rework:** One failed cleanup call and uncertainty about which retained identifier the lifecycle tool accepts
- **Recurrence / confidence:** Observed once with deterministic identifiers; high confidence in the interface mismatch
- **Ticket:** [HFM-20260729: Detach and refresh read-only review snapshots](../tickets/20260729-detach-and-refresh-readonly-review-snapshots.md)

## Behavior

A successful read-only delegate completion displayed `Read-only snapshot: bfd62193`. Passing that displayed identifier to `delegate_branches` with `action: drop` returned `No delegate worktree or continuation for bfd62193`. The completion separately displayed a continuation token, but did not identify it as the token required for cleanup.

## Impact

The agent cannot reliably clean up a retained read-only snapshot using the identifier labelled as the snapshot ID. This causes a failed tool call and leaves uncertainty about whether a retained ref still needs cleanup.

## Evidence

- Delegate outcome: successful unchanged read-only review in worktree isolation.
- Completion metadata included snapshot ID `bfd62193` and a separate continuation token.
- Cleanup attempt: `delegate_branches({ action: "drop", id: "bfd62193" })`.
- Deterministic result: `No delegate worktree or continuation for bfd62193`.

## Smallest improvement

Either accept the displayed read-only snapshot ID in `delegate_branches drop`, or label and expose the exact cleanup token in the completion output so the valid lifecycle call is unambiguous.
