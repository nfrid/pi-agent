# HF-20260802: Delegate sandbox exposes an unwritable HOME

- **Status:** triaged
- **Observed date:** 2026-08-02
- **Source cwd/repo:** /Users/nfrid/github/nfrid/piles
- **Task shape:** Parallel writable implementation and read-only verification delegates building a small Swift package
- **Harness component:** Delegate worktree runtime environment
- **Route / attempt / outcome:** luna-xhigh writable task and luna-high/sol-medium read-only reviews; compilation succeeded, but the project build wrapper could not complete its user-local linking step under the delegate environment
- **Observed cost / rework:** Delegates had to override HOME or report the verifier as partially failed; the parent repeated the exact build in its normal environment
- **Recurrence / confidence:** Observed independently in multiple delegates in this session; high confidence
- **Ticket:** [HFM-20260802: Forward the parent HOME to delegates](../tickets/20260802-forward-parent-home-to-delegates.md)

## Behavior

Delegate worktree processes resolved the user-local installation path under `/.local`, which was read-only. The parent process in the same task used `/Users/nfrid/.local` successfully.

## Impact

Repository verifiers that legitimately read or write user-scoped cache/config/bin paths fail only inside delegates. This creates false-negative verification results and forces environment overrides or repeated parent-side checks.

## Evidence

- Multiple delegate results reported that source compilation succeeded but the final `make build` linking step failed because it attempted to create or write `/.local`.
- A writable delegate succeeded only after explicitly running with `HOME=/tmp/piles-home`.
- The parent subsequently ran the unchanged `make build`; it linked `/Users/nfrid/.local/bin/piles-ctl` successfully.

## Smallest improvement

Give delegate runtimes a writable, isolated HOME by default while preserving ordinary home-relative path semantics.
