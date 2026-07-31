# HFM-20260731: Show the unintegrated delta in delegate review

- **Status:** evaluation-pending
- **Approval:** approved 2026-07-31
- **Created:** 2026-07-31
- **Source reports:** [HF-20260731: Follow-up delegate review cannot isolate the unmerged delta](../inbox/20260731T085515Z-delegate-incremental-review.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

After a writable delegate branch is merged and then continued for a focused fix, `delegate_branches review` repeats the complete original-base-to-branch history and diff. The parent must manually compare current HEAD with the retained branch to isolate the small change that remains unintegrated.

## Baseline

The observed HTTP and JSON branches were each merged, continued, and reviewed again. Each harness review repeated the accumulated task range—over a thousand changed lines in one case—while manual `git log HEAD..branch` and `git diff HEAD..branch` inspection was used to find the new fix, including commit `c536c45`.

This matches the implementation: `workRangeFor` in `extensions/delegate/worktree/integrate.ts` always returns the recorded original work range, and `reviewBranch` uses that range for log, stat, and diff. `branchState` separately uses patch identity for carried branches to know whether their work is already applied, but review emits no current-HEAD-relative section.

## Hypothesis

If review retains the auditable full task range and also identifies task patches not represented in current HEAD, then follow-up review will focus attention on the unintegrated fix without losing original branch provenance.

## Guardrails

- Keep the current full recorded-range review available and clearly label the incremental view separately.
- Preserve range ancestry validation; never inspect an unsafe rewritten range as trusted work.
- Account for carried-WIP branches whose integrated commits have different hashes after cherry-pick; do not rely only on commit-hash ancestry.
- Do not hide earlier commits, claim semantic equivalence from patch identity, or change merge behavior.
- Bound and truncate incremental output consistently with full review output.

## Options considered

1. **Add a current-HEAD incremental section or selector:** Reduces repeated context while preserving the full audit view; requires careful patch-identity handling.
2. **Replace full review with `HEAD..branch`:** Shorter, but loses stable provenance and can misclassify branches that diverged from an advancing parent.
3. **Keep manual Git commands:** No harness work, but repeats context-heavy review and asks agents to reconstruct carried-branch semantics themselves.

## Recommendation

Implement option 1 as an explicit `incremental` review selector rather than automatically appending both diffs. Preserve the existing full-base review as the default/audit view; the incremental view should derive unintegrated work with patch-aware comparison for carried branches and ordinary ancestry where safe. If no task patch remains, say so rather than returning an empty ambiguous range. The full view may include a bounded count hint that unintegrated patches exist, but must not duplicate the incremental diff.

## Scope

- **In:** Explicit current-HEAD-relative incremental review selector; carried-branch patch identity; full-view preservation and optional bounded count hint; output bounds; focused review tests.
- **Out:** Merge behavior; branch rebasing; semantic diff equivalence; automatic approval; removal of the existing recorded-range view.

## Acceptance criteria

- [ ] After an initial integration and one continuation commit, the explicit incremental review selector clearly isolates that unintegrated commit and its file diff from previously applied task work.
- [ ] The existing full recorded-base review remains the default/audit view and does not automatically duplicate the incremental diff.
- [ ] Carried-WIP branches identify already cherry-picked patches despite changed commit hashes and exclude the carry commit itself.
- [ ] A fully integrated branch reports no unintegrated task delta.
- [ ] An unrelated advance or dirty state in parent HEAD does not get presented as delegate-authored work.
- [ ] Unsafe rewritten ranges remain rejected, and both full and incremental output obey deterministic truncation limits.

## Validation

Extend delegate integration/review fixtures with ordinary and carried branches, initial merge, continuation fixes, equivalent cherry-picked patches, advancing parent HEAD, fully integrated state, rewritten-range rejection, and output truncation. Run focused delegate branch/integration tests, then `npm run check`.

## Evaluation

- **Window:** Started 2026-07-31; the first 10 post-integration continuation reviews or 2026-09-30, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline of two repeated full reviews requiring manual Git ranges. Keep only if every qualifying review isolates the actual unintegrated delta without omitting a pending patch or attributing parent work to the delegate. Record `insufficient evidence` if fewer than 3 qualifying reviews occur.

## Implementation and resolution

- **Approved implementation:** Add an explicit incremental `delegate_branches review` selector that shows only task patches not represented in current parent HEAD, using patch identity for carried branches; preserve the existing full review as the default/audit view and do not automatically append both diffs. Approved 2026-07-31.
- **Merged change:** `2a179b1` (implementation `ba67ed8 feat(delegate): add incremental branch review`); review fix `e85e2cd` (implementation `e983778 fix(delegate): harden branch review provenance and bounds`)
- **Resolution:** pending evaluation
