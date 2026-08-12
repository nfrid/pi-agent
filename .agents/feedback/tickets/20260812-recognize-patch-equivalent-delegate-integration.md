# HFM-20260812: Recognize patch-equivalent delegate integration during cleanup

- **Status:** proposed
- **Approval:** not approved
- **Created:** 2026-08-12
- **Source reports:** [HF-20260809: Delegate branch cleanup ignores patch-equivalent integration](../inbox/20260809T145146Z-delegate-drop-patch-equivalence.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

After a conflicted delegate branch is integrated by cherry-picking or recreating all task patches under different commit hashes, normal branch cleanup still treats the work as unmerged and requires destructive-force wording. The parent must re-audit work that the branch review path can already compare by patch identity.

## Baseline

The source report records a branch whose two task commits were cherry-picked after harness merge correctly aborted on conflict. All patches were present under new hashes, but normal `delegate_branches drop` refused and required `force: true`. The current incremental review contract explicitly identifies task commits not represented in parent HEAD by patch identity, while drop continues to protect based on its merged-state calculation. One observed cleanup therefore required a second manual equivalence check before force-dropping a fully represented branch.

## Hypothesis

If normal cleanup reuses the established patch-identity comparison and allows drop only when every recorded task patch is represented in current parent HEAD, then patch-equivalent integrations can be cleaned safely without force while branches with any missing task patch remain protected.

## Guardrails

- Exact ancestry remains the fast, preferred proof of integration.
- Patch identity is evidence of textual patch equivalence, not semantic equivalence; require every recorded task patch to match.
- Preserve carried-WIP exclusions and recorded task-range provenance.
- Refuse normal drop when the range is unsafe, rewritten unexpectedly, ambiguous, or only partially represented.
- Do not change merge behavior, auto-delete branches, or infer equivalence from final tree state alone.
- Keep `force: true` available as the explicit destructive override.

## Options considered

1. **Reuse incremental-review patch identity for normal drop:** Aligns review and cleanup with a known comparison while retaining fail-closed behavior for missing patches.
2. **Require exact commit ancestry:** Simple and current, but mislabels safe cherry-pick/conflict-resolution workflows as destructive.
3. **Compare final trees:** Handles squashes but can hide unrelated parent changes or omitted intermediate task patches.

## Recommendation

Implement option 1. Before refusing an otherwise healthy retained branch as unmerged, compare its validated recorded task patches with current parent HEAD using the same exclusions and patch-identity semantics as incremental review. Permit normal drop only when no task patch remains; report the proof used and keep force required for partial, unsafe, or indeterminate cases.

## Scope

- **In:** Patch-aware merged-state calculation for normal writable-branch drop; ordinary and carried-WIP ranges; clear proof/failure output; focused cleanup tests.
- **Out:** Semantic equivalence; final-tree-only comparison; merge or rebase automation; automatic branch deletion; rewritten-range refresh.

## Acceptance criteria

- [ ] A branch whose complete recorded task range was cherry-picked under different hashes can be dropped without `force`.
- [ ] A branch with any unmatched task patch remains protected and identifies the unmatched count without exposing an unbounded diff.
- [ ] Exact-ancestry integration retains current behavior.
- [ ] Carried parent WIP and excluded commits are never counted as delegate task patches.
- [ ] Reordered, duplicate, empty, and conflict-resolved patches are handled deterministically and fail closed when patch identity is not exact.
- [ ] Normal-drop refusal leaves the branch, worktree, and lifecycle record unchanged.

## Validation

Extend delegate integration fixtures with exact merges, clean cherry-picks, conflict-resolution cherry-picks with exact and changed patches, partial ranges, carried WIP, duplicate patches, advancing parent HEAD, and unsafe rewritten ranges. Assert cleanup state and messages, then run focused delegate branch/integration tests and `pnpm run check`.

## Evaluation

- **Window:** Not started; after an approved merge, the first 10 non-ancestry cleanup decisions including at least 5 patch-equivalent integrations, or 2026-10-31, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline one fully represented branch that required force and manual re-audit. Keep only if every complete patch-equivalent integration drops normally, every partial or indeterminate integration remains protected, and no retained task patch is lost.

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
