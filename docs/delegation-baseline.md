# Delegation baseline

Point-in-time aggregate captured 2026-07-28 with `session-metrics/v3`. The frozen, privacy-safe evidence is [`delegation-metrics-2026-07-28.json`](delegation-metrics-2026-07-28.json). It is an aggregate record, not a raw session dump and not a promise that a mutable `sessions/` directory can reproduce this historical capture.

The capture used:

```bash
npm run --silent session:metrics -- summarize sessions --min-delegate-calls 1
```

A later run measures the files present then; use it for a new point in time, not to restate this one.

## Cohort

59 sessions had at least one delegate call: 331 calls, 418 unique delegated runs, and 19 rejected calls. Fourteen background jobs/runs were launched. Their 21 parent-visible deliveries include repeated push/peek copies where applicable; those copies add handoff bytes but do not add executed tasks.

| Measurement | Value |
| --- | ---: |
| Handoff bytes per unique task | 2,455 B |
| Handoff bytes | 1,026,024 B |
| Truncation rate | 0.24% (1 of 418) |
| Continuation rate | 32.3% (107 of 331 calls) |
| Parallel calls | 62 |
| Writable tasks | 18 |
| Background jobs/runs launched | 14 / 14 |
| Background report deliveries | 21 |
| Process errors / timeouts / aborts | 10 / 11 / 2 |
| Reported outcomes done / partial / blocked / failed | 1 / 0 / 0 / 0 |
| Outcome unreported | 417 |
| Artifact references / worktree returns | 3 / 3 |

The outcome contract was absent from almost all reports in this capture. That makes the process counters useful failure signals, but it does **not** establish a capability or success rate. Future cohorts should reduce `delegateOutcomeUnreported` before using outcome counts to judge delegation quality.

## Interpretation

Handoff volume measures parent context received, including repeated background deliveries. It is not child runtime cost. Cost and routing coverage are in [`delegation-routing.md`](delegation-routing.md). The frozen record supports no claim about cap percentile behavior or causal effects from changing caps, so those claims are intentionally omitted.
