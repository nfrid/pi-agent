# Session metrics

`scripts/session-metrics` reads Pi session JSONL and emits privacy-safe aggregate measurements. It follows only the active ancestry, so abandoned branches do not inflate totals.

```bash
npm run session:metrics -- summarize ~/.pi/agent/sessions --min-delegate-calls 1
npm run session:metrics -- compare --baseline /path/to/baseline --comparison /path/to/comparison
```

JSON is written to stdout. `--limit` applies after filtering; `--min-todo-calls` and `--min-delegate-calls` can be combined.

## Delegation

The instrument reports delegate calls, continuations, accepted parallel calls, rejected calls, unique delegated and writable tasks, background jobs/runs launched, report deliveries, handoff bytes, truncation, report outcomes, process errors/timeouts/aborts, and artifact/worktree indicators.

Background completion facts come from producer details: automatic deliveries use `details.jobs`, while `delegate_jobs peek` uses `details.job`. A pushed report and a later peek each add their complete delivered text to `delegateHandoffBytes`, but stable job/run identities prevent either copy from adding another execution, outcome, truncation, or routing record. Current reports use `Delegated results: N run(s)` and `Truncation: original report truncated`; older markers remain readable. The display delimiter `\n\n---\n\n` is never parsed because parallel handoffs use it internally. Older messages without details receive only a one-report fallback.

## Routing and ratios

`routes` contains unique `routedTasks`: runs with both a route and recorded child usage. Each route reports tasks, turns, input/output usage, cost, and relative cost. `childTurnsPerTask` and `childCostPerTask` divide by `routedTasks`, not all delegated tasks or report copies.

Other ratios are `cacheHitRatio`, `delegateHandoffBytesPerTask`, `delegateTruncationRate`, and `delegateContinuationRate`. Cohort ratios are recomputed from summed totals, never averaged from per-session ratios.

## Privacy and interpretation

Output omits paths, prompts, tool arguments/results, task text, handoff bodies, and compaction summaries. Short session hashes are local correlation IDs, not anonymity guarantees. Provider usage is reported as recorded; elapsed time is the active-ancestry wall-clock span.

Metrics describe observed cost and reporting, not correctness. Compare cohorts only when task shapes are comparable.
