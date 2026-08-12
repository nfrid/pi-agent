# HFM-20260812: Refresh retained delegate records after an owner rebase

- **Status:** proposed
- **Approval:** not approved
- **Created:** 2026-08-12
- **Source reports:** [HF-20260812: Delegate branch record becomes unusable after owner rebase](../inbox/20260811T222417Z-delegate-branch-record-stale-after-rebase.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

When the owner rebases a healthy retained writable delegate branch, the lifecycle record remains anchored to the old head. Review, merge, and normal cleanup then reject the current branch even when direct Git ancestry proves it is healthy and integrated, forcing the owner outside the harness path.

## Baseline

The source report records deterministic refusals after two owner rebases: `delegate_branches review` said the previously recorded head was not an ancestor of the current ref; after a direct fast-forward integration, normal drop still considered the stale range unmerged. Direct Git checks proved current-main ancestry before integration and delegate-branch ancestry afterward, but review/merge/drop remained unavailable and cleanup required force. Current integration tests explicitly preserve rejection when a previously recorded head is not an ancestor, and no branch-record refresh operation is exposed.

## Hypothesis

If the owner can explicitly refresh a retained branch record to a verified current ref while preserving immutable original provenance, then review, merge, and cleanup can operate on rebased work without silently trusting arbitrary history rewrites.

## Guardrails

- Refresh must be explicit; never silently accept a rewritten branch ref.
- Preserve the original task base, original recorded head, owner/session identity, and refresh audit history.
- Require a clean, owned retained worktree and verify that the refreshed range still represents the task rather than unrelated replacement history.
- Refuse ambiguous, missing, cross-owner, detached, or concurrently changing refs without mutating the record.
- Do not perform the rebase, resolve conflicts, or claim semantic equivalence.
- Existing review bounds, dirty-check protections, merge rollback, and force-drop behavior remain intact.

## Options considered

1. **Explicit verified record refresh:** Restores the supported lifecycle with an auditable trust transition; requires a careful provenance check and atomic record update.
2. **Automatically follow the branch ref:** Convenient but silently accepts arbitrary rewritten history and weakens recorded-range provenance.
3. **Continue requiring direct Git plus force cleanup:** Fail-closed but makes normal harness review and integration unusable for a common owner operation.

## Recommendation

Implement option 1 as an explicit refresh operation or narrowly scoped review/merge option. Verify the current owned branch/worktree, record both old and new heads atomically, and establish a new auditable task range before allowing standard review, merge, and drop to proceed. If provenance cannot be established, leave the record untouched and provide the exact failed check.

## Scope

- **In:** Explicit retained writable-branch record refresh; provenance and ownership checks; atomic audit metadata; refreshed review/merge/drop behavior; concurrent-ref tests.
- **Out:** Performing rebases; automatic conflict resolution; silent ref following; read-only snapshot refresh; patch-equivalent cleanup without a rebase.

## Acceptance criteria

- [ ] An explicitly refreshed, clean owner-rebased branch becomes reviewable through a clearly labelled refreshed range.
- [ ] Standard merge and normal post-integration drop evaluate the verified current ref rather than the stale pre-rebase head.
- [ ] Original base/head provenance and every accepted refresh transition remain inspectable.
- [ ] Unrelated replacement history, ownership mismatch, dirty worktrees, missing refs, and ref races fail without changing the lifecycle record or checkout.
- [ ] A failed merge after refresh leaves parent HEAD and worktree unchanged and keeps the branch reviewable.
- [ ] Branches that were not rebased retain current behavior and require no refresh.

## Validation

Add fixtures for clean rebases onto advancing main, repeated rebases, conflict-resolved rebases, unrelated force-push replacement, dirty and detached worktrees, owner/session mismatch, compare-and-swap ref races, successful merge, and post-merge drop. Assert immutable provenance and atomic failure behavior, then run focused worktree record, review, integration, and branch-tool tests plus `pnpm run check`.

## Evaluation

- **Window:** Not started; after an approved merge, the first 10 explicit refresh attempts including at least 5 valid owner rebases and 3 invalid or racing refs, or 2026-10-31, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline one branch that required direct Git integration, independent ancestry checks, and forced cleanup. Keep only if valid rebases remain inside the harness lifecycle, every rejected refresh leaves state unchanged with an actionable reason, and no unrelated rewritten history is accepted as trusted task work.

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
