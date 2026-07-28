# Session metrics

`scripts/session-metrics` reads Pi session JSONL and emits privacy-safe aggregate measurements. It follows only the active ancestry, so abandoned branches do not inflate totals.

## Usage

```bash
npm run session:metrics -- summarize ~/.pi/agent/sessions --min-delegate-calls 1
npm run session:metrics -- compare --baseline /path/to/baseline --comparison /path/to/comparison
```

JSON is written to stdout. `--limit` applies after filtering; `--min-todo-calls` and `--min-delegate-calls` can be combined.

## Delegation semantics

- `delegatedTasks` and `delegateWritableTasks` count unique launched/executed runs, never a second pushed or peeked report copy.
- `delegateBackgroundJobsLaunched` and `delegateBackgroundRunsLaunched` describe work launched. `delegateBackgroundDeliveries` and `delegateHandoffBytes` describe parent-visible report copies. A pushed report and a later peek both add delivery bytes, but not tasks.
- `delegateParallelCalls` includes accepted parallel foreground and background launches. `delegateContinuationCalls` counts calls with either a single continuation or one or more parallel task continuations.
- `delegateRejectedCalls` is separate from runs. `delegateTruncatedTasks` is read from handoff markers and is capped to the report's task count.
- `delegateOutcomeDone`, `delegateOutcomePartial`, `delegateOutcomeBlocked`, and `delegateOutcomeFailed` come from the child report; `delegateOutcomeUnreported` makes historical reports without the contract visible. `delegateProcessErrors`, `delegateProcessTimeouts`, and `delegateProcessAborts` are process state, not capability outcomes.
- `delegateArtifactReferences` and `delegateWorktreeReturns` count details supplied with a unique run. `delegateArtifactFallbacks` counts parent-visible fallback markers.

## Routing and ratios

`routes` contains only `routedTasks`: unique runs with a route **and recorded child usage**. Each route reports tasks, turns, input/output usage, cost, and relative cost. There is no `computeUnits` field because the delegate runtime does not produce one.

`childTurnsPerTask` and `childCostPerTask` divide child spend by `routedTasks`, not by every delivered handoff or older unrouted run. Cohort ratios are always recomputed from summed totals: they are not averages of session ratios. `delegateEscalationRate` is escalations over all continuation calls, including parallel continuations; a call without enough route history remains in that denominator rather than silently changing its meaning.

Other ratios are `cacheHitRatio`, `delegateHandoffBytesPerTask`, `delegateTruncationRate`, and `delegateContinuationRate`.

## Privacy and interpretation

Output omits paths, prompts, tool arguments/results, task text, handoff bodies, and compaction summaries. Short session hashes are local correlation IDs, not anonymity guarantees. Provider usage is reported as recorded; elapsed time is wall-clock active-ancestry span.

Metrics describe cost and observed reporting, not correctness. Compare cohorts only when task shapes are comparable.
