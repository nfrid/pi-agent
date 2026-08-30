# HF-20260812: Delegate merge blocks a net-neutral path that is dirty in the parent

- **Status:** triaged
- **Observed date:** 2026-08-12
- **Source cwd/repo:** `/Users/nfrid/.pi/agent` (Pi harness repository)
- **Task shape:** Integrate an isolated delegate implementation while preserving unrelated concurrent edits in the shared checkout
- **Harness component:** `delegate_branches merge`
- **Route / attempt / outcome:** A `luna-high` implementation branch and a `luna-low` WIP-based transplant could not merge; a third `luna-low` branch that never touched the conflicting path merged successfully
- **Observed cost / rework:** Two refused merges and two mechanical transplant delegates were needed to land an already reviewed seven-file implementation
- **Recurrence / confidence:** Deterministically observed in this session; high confidence when a task commit history touches a parent-dirty path even though the task's final net diff does not
- **Ticket:** [HFM-20260830: Ignore net-neutral paths in delegate merge guards](../tickets/20260830-ignore-net-neutral-dirty-paths.md)

## Behavior

`delegate_branches merge` refused a WIP-based delegate branch because `docs/delegation.md` was dirty in the parent and appeared in the task's commit history. The delegate then added a follow-up commit that exactly removed its documentation addition, leaving no net task change to that file; branch metadata reported only seven changed paths and excluded the documentation file. Merge still rejected the branch as touching `docs/delegation.md`.

## Impact

A net-neutral path cannot be excluded by a corrective follow-up commit. The orchestrator must create another worktree and reconstruct the patch with commit history that never mentions the dirty path, adding avoidable delegation, review, and cleanup work while concurrent edits remain untouched.

## Evidence

- The WIP-based branch reported `Changed: 7 paths`, none of them `docs/delegation.md`, after the follow-up removal commit.
- `delegate_branches merge` still returned: `These paths are uncommitted here and also changed by the task ... docs/delegation.md`.
- A new branch applying the same implementation restricted to the seven non-documentation paths merged successfully.

## Smallest improvement

When guarding parent-dirty paths, treat a path with no net task diff from the carried base to the branch tip as unchanged. Do not refuse merge solely because intermediate task commits touched and then exactly restored that path.
