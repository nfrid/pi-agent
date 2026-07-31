# HF-20260731: Writable delegate timeout has no clean checkpoint window

- **Status:** parked
- **Observed date:** 2026-07-31
- **Source cwd/repo:** `/Users/nfrid/job`, `tracker-cli`
- **Task shape:** Bounded multi-file JSON contract implementation with an explicit deterministic verifier.
- **Harness component:** Delegate runtime timeout and writable worktree retention
- **Route / attempt / outcome:** Luna xhigh timed out after 1800 seconds; the branch retained a committed but malformed partial implementation. A continuation later repaired and completed it.
- **Observed cost / rework:** The orchestrator had to inspect corrupted partial files, re-brief the continuation, and later avoid the malformed commit history through a clean replay branch.
- **Recurrence / confidence:** One direct occurrence; medium confidence that long writable delegates can hit the same boundary.
- **Ticket:** [HFM-20260731: Add a pre-timeout delegate checkpoint](../tickets/20260731-pretimeout-delegate-checkpoint.md)

## Behavior

The writable delegate was terminated at the hard runtime limit without a reported clean-checkpoint phase. Its retained branch contained a commit where `src/cli/output.ts` included a literal `EOF` marker and embedded tool-call text. The completion correctly reported a timeout and retained the branch, but there was no indication that the child had been warned to stop implementation, validate the tree, and leave a clean checkpoint before termination.

## Impact

Retaining partial work is useful, but a committed malformed checkpoint looks more complete than it is and requires full forensic review before continuation. The timeout also converted a normal implementation into multiple recovery and integration runs.

## Evidence

- Delegate job `dj-3` ended with `timed-out` after 1800 seconds.
- Retained branch changed three paths and contained commit `a6e6474`.
- `delegate_branches review` exposed literal `EOF` and embedded write-tool text in `src/cli/output.ts`.
- Continuing the same delegate successfully cleaned the artifacts and completed the task.
- The exercised Luna xhigh route otherwise matched its documented bounded multi-file implementation use; this report concerns runtime checkpoint behavior, not route selection.

## Smallest improvement

Expose the effective delegate deadline to the child and provide a short pre-timeout checkpoint signal or grace window that instructs writable delegates to stop editing, run a minimal sanity check, and report/commit only a syntactically clean state before hard termination.
