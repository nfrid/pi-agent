# HF-20260729: Delegate completion is delivered twice after a settling peek

- **Status:** triaged
- **Observed date:** 2026-07-29
- **Source cwd/repo:** `/Users/nfrid/job` meta-repository
- **Task shape:** Parallel read-only research delegates followed by parent implementation
- **Harness component:** Background delegate completion delivery
- **Route / attempt / outcome:** A `delegate_jobs peek` with a bounded wait returned the completed `dj-2` result; the same completed result was then injected again as an automatic user-visible completion message.
- **Observed cost / rework:** The full research result occupied context twice and the parent had to recognize and ignore the duplicate.
- **Recurrence / confidence:** Observed directly for one background job; high confidence in the occurrence, unknown recurrence rate.
- **Ticket:** [HFM-20260729: Deduplicate peeked delegate completions](../tickets/20260729-deduplicate-peeked-delegate-completions.md)

## Behavior

When a background delegate settles during or near a manual `peek`, both the peek response and automatic completion delivery can present the same complete result.

## Impact

Large delegate reports can consume substantial context twice, obscure the actual user turn, and increase the chance that duplicate completion is mistaken for new evidence.

## Evidence

The Elastic 9.4 API audit completion for `dj-2` first appeared as the `delegate_jobs peek` result and immediately appeared again as a background delegate completion message with the same conclusion, evidence, risks, and continuation token.

## Smallest improvement

Deduplicate completion delivery by job ID: if a settling `peek` returns the terminal result, mark that completion as delivered and suppress the automatic duplicate.
