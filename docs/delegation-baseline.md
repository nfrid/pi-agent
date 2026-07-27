# Delegation baseline

Captured 2026-07-28 from `sessions/`, before any change to the handoff contract or caps. Reproduce with:

```bash
npm run --silent session:metrics -- summarize sessions --min-delegate-calls 1
```

Cohort: 59 sessions with at least one delegate call, 329 calls, 413 tasks that ran, 366 handoffs.

## What a handoff costs the parent today

| Measurement | Value |
| --- | --- |
| Handoff bytes per task (cohort) | 2,410 B |
| Handoff bytes per task (median session) | 2,075 B |
| Single-result bytes | p50 1,319 B, p90 5,156 B, p99 7,709 B, max 9,734 B |
| Parallel aggregate bytes | p50 5,153 B, max 26,078 B |
| Truncation rate | 0.2% (1 task of 413) |
| Continuation rate | 29.8% of calls |
| Parallel calls | 62 of 329 |
| Writable tasks | 18 of 413 |
| Rejected calls (no run launched) | 19 |
| Handoff tokens as a share of peak request context | p50 3.0%, p90 15.6%, max 33.1% |

## The caps do not bind

`PARENT_HANDOFF_CAPS` allows 12 KiB for a single result, 8 KiB per task in a parallel fan, and 50 KiB aggregate. Nothing in this cohort reached any of them: the largest single result is 9,734 B and the largest parallel aggregate is 26,078 B, and the one truncated task in 413 is the whole of the truncation rate.

Lowering the single cap to 6 KiB would clip 5.2% of results and remove 1.4% of all handoff bytes. So the caps are a guardrail against a pathological run, not an economy lever, and a cap change alone cannot produce a material reduction in what delegation costs the parent.

Handoff volume is instead set by how much children choose to write. Reducing it is a report-contract problem: denser reports, with the decision-relevant fields in the envelope where truncation cannot reach them.

## Reading these numbers later

A comparison cohort is only meaningful against similar task shapes. Continuations are frequently deliberate corrections rather than failures, and a clean exit is not evidence of correct work. The share-of-context figures convert bytes to tokens at a flat 4 bytes per token and are indicative only.
