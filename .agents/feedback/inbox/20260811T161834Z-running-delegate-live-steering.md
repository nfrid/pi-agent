# HF-20260811: Running delegates cannot receive corrective steering

- **Status:** new
- **Observed date:** 2026-08-11
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Long-running dashboard refactor recovery with several isolated writable implementation and audit delegates
- **Harness component:** `delegate` / `delegate_jobs` background delegation lifecycle
- **Route / attempt / outcome:** Background `luna-high` writable delegates were inspected while running; corrective findings could not be delivered until each run completed
- **Observed cost / rework:** Known defects continued through the remainder of active runs, requiring follow-up continuations and repeated validation; starting a sibling would risk overlapping edits
- **Recurrence / confidence:** Observed repeatedly in this session; high confidence for long-running delegated implementation and review tasks
- **Ticket:** —

## Behavior

A parent agent can inspect an active delegate's worktree and discover actionable defects, but the harness exposes no operation to send bounded feedback to that running delegate. `delegate_jobs` supports listing, peeking, and cancellation only. A `delegate` continuation is available after completion, not as an in-run message channel.

## Impact

The parent must choose between waiting for avoidable work to finish, cancelling and losing useful progress, or starting an overlapping sibling branch. This increases latency, repeated test cost, merge risk, and context churn. It also encourages imprecise narration such as saying a running agent was “steered” when only a later continuation is possible.

## Evidence

During this task, parent inspection of active writable delegate worktrees found concrete issues before completion, including temporary debug logging, an omitted TypeScript interface field, incomplete persisted-message classification, and an overly strict provenance comparison. The parent could record these findings but could not deliver them to the active jobs. Corrections therefore had to wait for completion and be issued as additional continuations.

This is a harness capability gap, not a route mismatch: the exercised `luna-high` route matched bounded background implementation with explicit acceptance criteria.

## Smallest improvement

Add a safe live-feedback operation for active delegate jobs. It should accept a bounded parent message addressed to one job, acknowledge whether it was queued or delivered, preserve the delegate's existing route/write/isolation capabilities, and present the feedback to the delegate at its next tool or reasoning checkpoint. If the job settles before delivery, return that state so the parent can use a normal continuation instead.
