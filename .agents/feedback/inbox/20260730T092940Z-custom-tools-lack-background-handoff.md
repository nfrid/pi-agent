# HF-20260730: Long-running custom tools lack a reusable background handoff

- **Status:** triaged
- **Observed date:** 2026-07-30
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Add a slow external-model consultation capability that should be rare, cancellable, and able to finish while Pi continues other work.
- **Harness component:** Extension custom tools and background execution
- **Route / attempt / outcome:** A synchronous custom tool safely wrapped the external CLI but blocked the agent turn; background behavior would have required a separate job manager. The capability was ultimately moved to an explicit skill that delegates execution to the existing background-process tool.
- **Observed cost / rework:** Substantive extension lifecycle, subprocess, cancellation, output-boundary, and test code was built and then removed after live use showed that foreground latency dominated the experience.
- **Recurrence / confidence:** Likely for external reviewers, remote jobs, and other slow custom tools; high confidence from repeated live consultations taking tens of seconds while the tool call blocked.
- **Ticket:** [HFM-20260730: Reuse the background lifecycle for custom tools](../tickets/20260730-reuse-background-lifecycle-for-custom-tools.md)

## Behavior

A custom tool's `execute` call is foreground from the agent loop's perspective. Extensions can implement their own detached job registry and completion delivery, but there is no small host-level handoff to the existing background-process lifecycle. The built-in/background extension already provides start, cancellation, bounded output, status, and automatic completion delivery, but a custom extension cannot reuse that behavior as a simple execution mode.

## Impact

Long-running integrations must choose between blocking the turn, duplicating substantial async-job machinery, or abandoning a typed custom tool in favor of instructional skill-driven shell execution. This makes safe but slow integrations disproportionately expensive and can push implementations away from structured tool contracts.

## Evidence

- Live external-model consultations took roughly tens of seconds to over a minute while their custom tool call remained foreground.
- The implementation already had cancellation and process-tree cleanup, but adding user-visible background behavior still required job IDs, status, completion delivery, and lifecycle management.
- Reusing Pi's existing background tool through an explicit skill immediately provided asynchronous execution without that duplicated extension machinery.

## Smallest improvement

Offer a documented reusable background handoff for custom tools that provides a job identifier, cancellation, bounded output, and automatic completion delivery, without requiring each extension to recreate the background job lifecycle.
