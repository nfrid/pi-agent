# HF-20260809: Delegate branch cleanup ignores patch-equivalent integration

- **Status:** new
- **Observed date:** 2026-08-09
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Concurrent dashboard fix implemented through isolated writable delegates, with one conflicted integration resolved by cherry-picking the delegate commits.
- **Harness component:** `delegate_branches drop`
- **Route / attempt / outcome:** A `luna-high` writable branch was integrated by cherry-picking its two commits after `delegate_branches merge` correctly aborted on a conflict. A later `drop` refused because the original commit hashes were not ancestors, although their patches were present under new hashes; cleanup required `force: true`.
- **Observed cost / rework:** Required manual verification that no delegate work would be lost before forcing cleanup, despite patch-aware review already being available.
- **Recurrence / confidence:** Likely whenever conflicted delegate commits are cherry-picked or otherwise recreated; high confidence from the deterministic branch state and tool response.
- **Ticket:** —

## Behavior

`delegate_branches drop` treats a writable branch as unmerged when its exact commits are absent from parent history, even if all task patches are represented by patch identity after a conflict-resolution cherry-pick.

## Impact

Safe cleanup becomes indistinguishable from destructive cleanup. The agent must re-audit integration and use `force: true`, which adds risk and leaves retained delegate branches unnecessarily when it declines to force.

## Evidence

- `delegate_branches merge` for the retained branch aborted on a conflict in one dashboard test file.
- The task commits were then cherry-picked and resolved into parent commits with different hashes.
- `delegate_branches review` already supports patch-aware incremental comparison.
- Subsequent `delegate_branches drop` returned: the branch "is not merged; its commits would be lost" and required `force: true`.

## Smallest improvement

Before refusing cleanup, let `delegate_branches drop` recognize that every retained task patch is represented in current parent history using the same patch-identity logic available to incremental review. Preserve the force requirement only when an actual task patch is absent.
