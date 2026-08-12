# HF-20260812: Delegate branch record becomes unusable after owner rebase

- **Status:** triaged
- **Observed date:** 2026-08-12
- **Source cwd/repo:** `/Users/nfrid/.pi/agent` harness repository
- **Task shape:** Isolated multi-file dashboard implementation, repeated review, rebase onto advancing main, then integration and cleanup
- **Harness component:** `delegate_branches` retained writable-branch lifecycle
- **Route / attempt / outcome:** Writable Luna branch completed; after the owner rebased its retained branch, `delegate_branches review`, merge, and normal drop refused to operate on the current branch ref
- **Observed cost / rework:** Required direct Git review/fast-forward integration, an independent ancestry check, and forced cleanup instead of the harness integration path
- **Recurrence / confidence:** Observed once with deterministic repeated refusals after two rebases; high confidence for retained branches whose history is rewritten
- **Ticket:** [HFM-20260812: Refresh retained delegate records after an owner rebase](../tickets/20260812-refresh-rebased-delegate-branch-records.md)

## Behavior

A retained writable delegate branch was rebased by the owner onto an advancing main branch. The branch ref and worktree were healthy, but the branch record continued to require its previously recorded head to be an ancestor of the current ref. Review refused because that old head was no longer an ancestor. After the current branch was fast-forwarded into main, normal drop still reported the branch as unmerged because it evaluated the stale recorded range rather than the current ref.

## Impact

The supported review/merge/drop workflow becomes unavailable precisely when an owner rebases an isolated branch to preserve concurrent main changes. The owner must bypass harness integration with direct Git commands, and cleanup requires `force` despite a positive current-ref ancestry check. That increases integration risk and makes branch status misleading.

## Evidence

- `delegate_branches review` reported that the previously recorded head was not an ancestor of the branch and refused inspection.
- The current branch was clean and `git merge-base --is-ancestor <current-main> <delegate-branch>` succeeded before a direct fast-forward merge.
- After merge, `git merge-base --is-ancestor <delegate-branch> HEAD` succeeded, but normal `delegate_branches drop` still said the branch was not merged.
- Forced drop succeeded only after the owner independently proved current-ref ancestry.

## Smallest improvement

Allow a retained writable branch record to refresh to the current branch ref after an owner-side rebase, while preserving the original task provenance. Review, merge, and merged-state cleanup should then evaluate the refreshed current ref rather than permanently requiring the pre-rebase recorded head to remain its ancestor.
