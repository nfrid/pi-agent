# HF-20260805: Delegate branch review lacks bounded diff controls

- **Status:** triaged
- **Observed date:** 2026-08-05
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Review and integrate a successful multi-file dashboard implementation delegate.
- **Harness component:** `delegate_branches review`
- **Route / attempt / outcome:** A writable `luna-xhigh` delegate completed successfully; the parent then reviewed its 14-path branch before merging.
- **Observed cost / rework:** The review emitted a very large patch, including hundreds of lines of mostly structural JSX reindent, so the parent had to inspect targeted files separately to make the review actionable.
- **Recurrence / confidence:** Likely recurring for medium-to-large delegated implementations; high confidence.
- **Ticket:** [HFM-20260805: Add bounded views to delegate branch review](../tickets/20260805-bound-delegate-branch-review.md)

## Behavior

`delegate_branches review` returns the complete recorded patch without options to request only a summary, selected paths, or a bounded patch. In this task the review included a 426-line renderer-file rewrite within an overall roughly 800-line insertion patch, although the parent first needed architectural changes and risk hotspots rather than every changed line.

## Impact

Large successful delegate branches can consume substantial parent context before the parent knows which files require close inspection. The unbounded output also makes mechanical formatting or reindent changes compete with consequential behavior changes during mandatory pre-merge review.

## Evidence

- Reviewed delegate commit: `f570a78 feat(dashboard): add workspace overlays and motion pass`.
- Review covered 14 paths and reported 798 insertions / 317 deletions.
- `apps/dashboard-web/src/features/live-surface-renderers.tsx` alone contributed a 426-line diff dominated by conditional-wrapper removal and reindent.
- The parent subsequently used targeted file reads and focused checks to assess the meaningful changes.

## Smallest improvement

Allow `delegate_branches review` to return a compact summary or a bounded/path-filtered patch, such as `statOnly`, `paths`, and `maxPatchLines`, while retaining the current full review as an explicit option.
