# HF-20260729: Read-only review worktrees are presented as integration branches

- **Status:** triaged
- **Observed date:** 2026-07-29
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Fresh isolated regression review of an uncommitted four-file UI diff
- **Harness component:** Delegate worktree lifecycle and completion presentation
- **Route / attempt / outcome:** `luna-high`, `allowWrites: false`, `isolation: worktree`, `from: wip`; review succeeded with no changes
- **Observed cost / rework:** Completion advertised a branch and integration command despite a clean read-only run; the parent manually force-dropped the worktree/branch.
- **Recurrence / confidence:** Observed once; high confidence for read-only worktree reviews
- **Ticket:** [HFM-20260729: Detach and refresh read-only review snapshots](../tickets/20260729-detach-and-refresh-readonly-review-snapshots.md)

## Behavior

A read-only worktree delegate that made no changes returned `Branch`, `Worktree`, and `Integrate with` fields exactly like a writable implementation task. The checkout then remained registered until the parent called `delegate_branches drop --force`.

## Impact

The completion suggests that review output needs merging when it cannot contain edits, and leaves lifecycle cleanup to the parent. This adds an unnecessary command and risks accumulating stale review worktrees when agents correctly treat `delegate_branches` as primarily an integration mechanism for writable runs.

## Evidence

- Delegate request used `allowWrites: false`, `isolation: worktree`, and `from: wip`.
- Completion reported a clean worktree and no changes, but still emitted an integration ID and instructions.
- Cleanup required `delegate_branches drop` with `force: true`.

## Smallest improvement

Automatically remove clean read-only delegate worktrees when the run ends, and omit branch/integration instructions from their completion output.
