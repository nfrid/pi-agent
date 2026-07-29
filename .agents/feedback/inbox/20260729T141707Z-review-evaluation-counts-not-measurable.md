# HF-20260729: Review snapshot evaluation counts are not measurable

- **Status:** new
- **Observed date:** 2026-07-29
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Evaluate pending harness tickets against operational run-count thresholds
- **Harness component:** Delegate lifecycle observability and session metrics
- **Route / attempt / outcome:** Real read-only WIP review and same-snapshot continuation succeeded; counts had to be reconstructed and recorded manually
- **Observed cost / rework:** Manual tracking was required for clean review runs, same-snapshot continuations, refresh attempts, and WIP dependency projections
- **Recurrence / confidence:** Applies to every run-count evaluation window using these lifecycle distinctions; high confidence
- **Ticket:** —

## Behavior

The privacy-safe session metrics report aggregate delegate calls, continuations, and worktree returns, but they do not distinguish successful clean read-only snapshots, same-snapshot continuations, WIP versus HEAD refreshes, or dependency links projected for carried packages. Pending tickets use those distinctions as explicit evaluation thresholds.

## Impact

The harness cannot determine from aggregate evidence whether snapshot and WIP-package evaluation windows have reached their required samples. Maintainers must remember and manually edit counts, increasing the risk of undercounting, double-counting, or closing a ticket without the required mix of runs.

## Evidence

This session completed one real isolated WIP-package review and one same-snapshot continuation, then encountered one WIP-refresh failure. `session:metrics` exposed aggregate delegate and worktree counts but not those lifecycle categories, so the ticket observations were recorded manually as 2 clean runs, 1 same-snapshot continuation, 0 successful refreshed continuations, and 1 WIP-package review.

## Smallest improvement

Emit privacy-safe structured lifecycle counters for read-only clean retirement, same-snapshot continuation, WIP/HEAD refresh outcome, and dependency projection, without storing task text, paths, or transcript content.
