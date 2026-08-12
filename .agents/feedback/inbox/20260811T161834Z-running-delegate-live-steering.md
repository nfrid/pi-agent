# HF-20260811: Running delegates cannot receive corrective steering

- **Status:** parked
- **Observed date:** 2026-08-11
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Long-running dashboard refactor recovery with several isolated writable implementation and audit delegates
- **Harness component:** `delegate` / `delegate_jobs` background delegation lifecycle
- **Route / attempt / outcome:** Background `luna-high` writable delegates were inspected while running; corrective findings could not be delivered until each run completed
- **Observed cost / rework:** Known defects continued through the remainder of active runs, requiring follow-up continuations and repeated validation; starting a sibling would risk overlapping edits
- **Recurrence / confidence:** Observed repeatedly in this session; high confidence for long-running delegated implementation and review tasks
- **Ticket:** —

## Triage decision

Parked without a ticket on 2026-08-12 because the observed capability gap is absent from the current source. `delegate_jobs` now exposes a bounded `feedback` action, queues one parent message to a running child for its next safe checkpoint, and reports when the job settled before delivery; focused coverage exists in `extensions/delegate/jobs-tool.test.ts`, `jobs.test.ts`, and `control.test.ts`. The implementation is present in `e4161e2` (`feat(delegate): add bounded runtime supervision`).

Reconsider only if a live background delegate cannot receive queued feedback under the documented boundary. Foreground delegation remains intentionally unsteerable while the parent is suspended in its tool call, and feedback does not interrupt an in-flight child tool call.

## Behavior

A parent agent can inspect an active delegate's worktree and discover actionable defects, but the harness exposes no operation to send bounded feedback to that running delegate. `delegate_jobs` supports listing, peeking, and cancellation only. A `delegate` continuation is available after completion, not as an in-run message channel.

## Impact

The parent must choose between waiting for avoidable work to finish, cancelling and losing useful progress, or starting an overlapping sibling branch. This increases latency, repeated test cost, merge risk, and context churn. It also encourages imprecise narration such as saying a running agent was “steered” when only a later continuation is possible.

## Evidence

During this task, parent inspection of active writable delegate worktrees found concrete issues before completion, including temporary debug logging, an omitted TypeScript interface field, incomplete persisted-message classification, and an overly strict provenance comparison. The parent could record these findings but could not deliver them to the active jobs. Corrections therefore had to wait for completion and be issued as additional continuations.

This is a harness capability gap, not a route mismatch: the exercised `luna-high` route matched bounded background implementation with explicit acceptance criteria.

## Smallest improvement

Add a safe live-feedback operation for active delegate jobs. It should accept a bounded parent message addressed to one job, acknowledge whether it was queued or delivered, preserve the delegate's existing route/write/isolation capabilities, and present the feedback to the delegate at its next tool or reasoning checkpoint. If the job settles before delivery, return that state so the parent can use a normal continuation instead.
