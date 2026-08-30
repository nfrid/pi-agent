# HF-20260814: Retained writable worktree cannot transfer to a replacement delegate

- **Status:** parked
- **Observed date:** 2026-08-14
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Bounded implementation delegate followed by audit-driven corrections in the same retained writable worktree
- **Harness component:** Delegate continuation and writable-worktree ownership lifecycle
- **Route / attempt / outcome:** A `luna-xhigh` writable delegate timed out after committing, then rewrote its checkpoint commit during continuation. Later continuations returned invalid structured results without applying requested fixes. A fresh delegate could not attach to the retained worktree because it was still owned by the original delegate record.
- **Observed cost / rework:** The parent had to create a second Git worktree and branch manually, then brief a replacement delegate against that checkout.
- **Recurrence / confidence:** Observed once end to end with repeated continuation failures; high confidence in the blocked sequential-handoff behavior.
- **Ticket:** —

## Triage decision

Parked on 2026-08-30 because the reported `worktreePath` takeover flow is no
longer the model-facing workflow. Current delegation uses `base` to start a
fresh child from an upstream node's exact resulting code state in a fresh
isolated workspace, while retaining the upstream handoff. Reconsider only if a
current `base` replacement cannot preserve a settled writable node's exact code
state or provenance without manual Git worktree management.

## Behavior

After the original delegate rewrote its recorded checkpoint head, lifecycle settlement refused the branch because the prior head was no longer an ancestor. The continuation remained nominally usable but repeatedly returned an invalid result without making changes. A fresh delegate could not take over the clean retained checkout sequentially because `worktreePath` was reported as already attached to a delegate session or retained worktree record.

## Impact

A recoverable code state became operationally stranded between a broken continuation and exclusive worktree ownership. This prevents replacing a failed child while preserving its exact checkout, adds manual Git worktree management, and weakens the intended delegate review/fix workflow.

## Evidence

- Retained branch state remained clean and usable at commit `bd56917`.
- Lifecycle settlement reported that the recorded checkpoint head was not an ancestor of the rewritten branch head and refused to replace provenance.
- Two corrective continuations returned `child-result-invalid` and left the branch unchanged.
- A fresh read/write delegate using the retained `worktreePath` failed setup because the path was already attached to the prior delegate record.
- Creating a separate caller-owned worktree at `bd56917` allowed a fresh delegate to complete and commit the same bounded corrections.

Existing inbox titles already cover stale branch records after rebase and missing structured-result channels, so this report is limited to the distinct inability to transfer a retained clean worktree to a replacement delegate after the original continuation becomes unusable.

## Smallest improvement

Provide an explicit sequential handoff/release operation for retained writable worktrees: once no delegate is running, allow the parent to detach the failed delegate record and attach a fresh delegate to the same clean checkout without merging, deleting, or recreating the branch. Preserve the original provenance as history and surface prose output as a fallback when structured result validation fails.
