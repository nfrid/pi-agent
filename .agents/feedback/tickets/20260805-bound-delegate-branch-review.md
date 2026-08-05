# HFM-20260805: Add bounded views to delegate branch review

- **Status:** proposed
- **Approval:** approved 2026-08-05
- **Created:** 2026-08-05
- **Source reports:** [HF-20260805: Delegate branch review lacks bounded diff controls](../inbox/20260805T160610Z-delegate-review-needs-bounded-diff.md)

## Problem

`delegate_branches review` always renders its log, stat, and patch for the selected full or incremental range up to fixed internal character caps. The caller cannot first request only a summary, selected paths, or a smaller patch budget, so mandatory pre-merge review of a medium branch can consume substantial context before risk hotspots are identified.

## Baseline

Reviewing commit `f570a78` emitted a 14-path patch with 798 insertions and 317 deletions; one renderer file contributed a 426-line largely structural diff. The parent then used targeted reads to assess meaningful changes. `extensions/delegate/branches-tool.ts` currently exposes only `incremental`; `worktree/integrate.ts` applies fixed bounds separately to log, stat, and diff. The existing incremental-review ticket preserves deterministic truncation but does not let callers select paths or a summary-only view.

## Hypothesis

If review supports a summary-only view plus validated path and patch-budget selectors, then parents can identify consequential files before spending context on detailed patches while still retaining an explicit full recorded-range audit.

## Guardrails

- Preserve the existing full recorded-range review and incremental patch-aware semantics.
- Never treat a bounded or path-filtered view as proof that omitted changes were reviewed.
- Show selected filters, total changed-path counts, and deterministic omission/truncation evidence.
- Reject unsafe paths and invalid budgets; do not interpolate caller input into shell commands.
- Do not weaken the requirement to review a writable delegate before merge.

## Options considered

1. **Add `statOnly`, `paths`, and a bounded patch limit:** Flexible and composable, with a larger tool schema and test surface.
2. **Add only summary then rely on file reads:** Smallest change, but cannot obtain a focused branch-relative patch.
3. **Keep fixed truncation:** Simple, but callers still receive irrelevant patch sections first and must reconstruct ranges manually.

## Recommendation

Add an explicit summary-only selector and safe path filtering. Add a bounded patch budget only if its unit and minimum/maximum are deterministic; always report omitted paths/lines and retain the current full view when selectors are absent.

## Scope

- **In:** Review summary mode; path-filtered full/incremental diffs; caller-selected bounded patch output; provenance and omission labels.
- **Out:** Semantic diff ranking, automatic approval, merge behavior, generated-file detection, or changing incremental patch identity.

## Acceptance criteria

- [ ] Summary-only review returns provenance, state, commits, stat, and bounded changed paths without patch bodies.
- [ ] Path filtering returns only matching delegate-authored diffs while reporting the total branch path count and active filter.
- [ ] A caller-selected patch budget truncates deterministically and reports what was omitted.
- [ ] Full and incremental modes retain their existing range and patch-identity semantics under every selector.
- [ ] Unsafe path selectors and out-of-range budgets fail closed, and the unfiltered default remains available.

## Validation

Extend integration fixtures with a multi-path large diff, path names containing shell metacharacters, full and incremental modes, no matches, summary-only output, and minimum/maximum budgets. Assert provenance and omission labels, run focused branch/integration tests, then `npm run check`.

## Evaluation

- **Window:** After an approved merge, the first 10 reviews of branches changing at least 10 paths, or 2026-09-30, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline 14-path review that required follow-up targeted reads. Keep only if bounded views identify all subsequently inspected risk paths, no selector misattributes work, and at least 8 of 10 eligible reviews avoid an initial full patch emission.

## Implementation and resolution

- **Approved implementation:** Add summary-only, safe path-filtered, and deterministically bounded patch views while preserving full and incremental provenance, explicit omission evidence, and the existing unfiltered review; approved by the user on 2026-08-05.
- **Merged change:** —
- **Resolution:** pending evaluation
