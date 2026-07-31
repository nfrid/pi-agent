# HF-20260731: Follow-up delegate review cannot isolate the unmerged delta

- **Status:** triaged
- **Observed date:** 2026-07-31
- **Source cwd/repo:** `/Users/nfrid/job`, `tracker-cli`
- **Task shape:** Writable delegate implementation followed by review findings, continuation fixes, repeated review, and repeated merge.
- **Harness component:** `delegate_branches review`
- **Route / attempt / outcome:** Luna xhigh implementer completed an initial branch, then several writable continuations added focused fixes after earlier commits had already been merged.
- **Observed cost / rework:** Each harness review repeated the full base-to-branch diff; the orchestrator used manual Git ranges to inspect only the new fix commits.
- **Recurrence / confidence:** Likely for every retained writable continuation after partial integration; high confidence from repeated observation in two phases.
- **Ticket:** [HFM-20260731: Show the unintegrated delta in delegate review](../tickets/20260731-show-incremental-delegate-review.md)

## Behavior

`delegate_branches review` always measures the retained branch from its original starting point. After an earlier branch tip has been merged and a continuation adds one focused fix, review still displays all prior commits and the entire accumulated diff. It does not identify the commits or file delta not yet contained in the current parent HEAD.

## Impact

Large repeated diffs consume review context and make it easier to miss the small new change that actually needs approval. In this session, accumulated reviews exceeded a thousand changed lines even when the new fix touched only a few locations. The orchestrator had to run `git log HEAD..branch` and `git diff HEAD..branch` manually before each subsequent merge.

## Evidence

- The HTTP-layer branch was merged, continued for review fixes, and merged again.
- `delegate_branches review` continued to show the original base and full accumulated seven-path diff.
- Manual commands against `HEAD..pi/http-layer-implementer` were needed to isolate commits such as `c536c45`.
- The same pattern recurred with `pi/json-contract-clean-integrator` for later security fixes.

## Smallest improvement

When a retained branch has previously been merged, let `review` show an additional “not contained in current HEAD” commit list and diff, or provide an explicit incremental review selector while retaining the existing full-base view.
