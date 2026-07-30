# HF-20260730: Measure end-to-end task outcomes, not only harness events

- **Status:** triaged
- **Observed date:** 2026-07-30
- **Source cwd/repo:** `/Users/nfrid/job` meta-repository
- **Task shape:** Review the current agent workspace and prioritize the next autonomy and efficiency improvements
- **Harness component:** session metrics and evaluation
- **Route / attempt / outcome:** A `sol-medium` read-only delegate was attempted twice; both attempts ended with provider-overload errors and produced no review
- **Observed cost / rework:** The parent completed the review directly, but current metrics do not establish whether the workflow revision improved task completion, intervention rate, or time to validated output
- **Recurrence / confidence:** The measurement gap is directly visible in current documentation; the value of a replay corpus still needs evaluation
- **Ticket:** [HFM-20260730: Derive task outcome episodes automatically](../tickets/20260730-derive-task-outcome-episodes.md)

## Behavior

Pi already records detailed session and delegation mechanics, but the documented metrics center on delegate calls, delivery paths, handoff size, outcomes, and tool-argument blocks. They do not provide a standard end-to-end task evaluation covering completion without intervention, time to first useful edit, time to validation, repeated discovery, validation retries, or parent rework.

## Impact

Prompt, routing, tool-schema, and context changes can be optimized against local measurements while their effect on actual task success remains unclear. Provider or route failures such as the two overload outcomes in this session are observable, but their effect on whether the parent still completed efficiently is not represented as one task-level outcome.

## Evidence

- `~/.pi/agent/docs/session-metrics.md` documents detailed delegation instrumentation, including outcomes, handoff bytes, truncation, and delivery overlap.
- In this session, background jobs `dj-1` and `dj-2` both returned `Codex error: Our servers are currently overloaded`; the parent continued without a child result.
- The workspace has a byte-size benchmark for `mg brief` at `mg/docs/brief-benchmark.md`, but it explicitly measures payload size rather than provider tokens or task completion.

## Smallest improvement

Define a small task-outcome record or report that can correlate existing session metrics with completion, user interventions, elapsed milestones, final validation, and parent rework. Evaluate that first on a few sanitized task shapes before building a larger replay framework.
