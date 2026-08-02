# HF-20260802: Batch delegate results duplicate task output

- **Status:** parked
- **Observed date:** 2026-08-02
- **Source cwd/repo:** /Users/nfrid/github/nfrid/piles
- **Task shape:** Three parallel repository audits followed by three parallel writable implementations
- **Harness component:** `delegate` batch result rendering
- **Route / attempt / outcome:** Batched luna-xhigh tasks completed successfully; each task's detailed conclusion/evidence was rendered in the aggregate section and then repeated in a per-task output section
- **Observed cost / rework:** Large audit findings were inserted twice into the parent context, reducing the context saved by delegation
- **Recurrence / confidence:** Observed on both multi-task delegate calls in this session; high confidence
- **Ticket:** —

## Triage decision

Parked without a ticket on 2026-08-02 because the observed rendering shape is already absent from the current source. `buildParentHandoffResult` now emits compact per-task envelopes and keeps exact reports artifact-only after successful publication; `extensions/delegate/output.test.ts` explicitly rejects the old `### Task 1 output` heading. Inline report bodies remain only as a bounded, visibly labelled fallback when artifact publication fails.

This is distinct from the existing peek/automatic-delivery deduplication ticket, which concerns the same job entering context through two delivery paths rather than duplicate sections in one batch result. Reconsider only if a live batch after extension reload or process restart still repeats exact task output; capture whether artifact publication succeeded and which runtime generation produced the handoff.

## Behavior

A successful batched `delegate` response presents a detailed result for every child under the aggregate results and then repeats those same detailed results under separate `Task N output` headings.

## Impact

The duplicate text can consume substantial parent context precisely when delegation is being used to conserve it. Repository audits with file-level evidence are especially costly because each child result is already long.

## Evidence

- The three-child audit response contained complete conclusions, evidence, and risks in its initial task result blocks, followed by the same three full outputs again.
- The subsequent three-child implementation response used the same duplicated structure.
- No continuation or tool call was needed to obtain the second copy; both copies were returned by one batch call.

## Smallest improvement

Render each child result once. Keep the aggregate section to compact status, branch/continuation identifiers, and a short outcome, with detailed output only in the per-task section.
