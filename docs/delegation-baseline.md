# Delegation baseline

Captured 2026-07-28 from `sessions/`, before any change to the handoff contract or caps. Reproduce with:

```bash
npm run --silent session:metrics -- summarize sessions --min-delegate-calls 1
```

Cohort: 59 sessions with at least one delegate call, 329 calls, 414 tasks that ran.

Restated after `07e22be` corrected how background delegation is counted. The earlier figures charged each background acknowledgement with tasks it had not yet done and never counted the report it later delivered, which understated per-task bytes and inflated the parallel-call count. The summarize command reports cohort totals; the per-result percentiles below come from a separate pass over the same corpus applying the same counting rules.

## What a handoff costs the parent today

| Measurement | Value |
| --- | --- |
| Handoff bytes per task (cohort) | 2,460 B |
| Single-result bytes | p50 1,360 B, p90 4,815 B, p99 7,368 B, max 9,734 B |
| Parallel aggregate bytes | p50 6,756 B, p90 20,453 B, max 26,078 B |
| Truncation rate | 0.24% (1 task of 414) |
| Continuation rate | 29.8% of calls |
| Parallel calls | 60 of 329 |
| Writable tasks | 18 of 414 |
| Rejected calls (no run launched) | 19 |
| Background jobs started / delivered | 10 / 13 |
| Handoff tokens as a share of peak request context | p50 3.4%, p90 17.7%, max 23.0% |

## The caps do not bind

`PARENT_HANDOFF_CAPS` allows 12 KiB for a single result, 8 KiB per task in a parallel fan, and 50 KiB aggregate. Nothing in this cohort reached any of them: the largest single result is 9,734 B and the largest parallel aggregate is 26,078 B, and the one truncated task in 414 is the whole of the truncation rate.

Lowering the single cap to 6 KiB would clip 4.4% of single results and remove 1.0% of all handoff bytes. So the caps are a guardrail against a pathological run, not an economy lever, and a cap change alone cannot produce a material reduction in what delegation costs the parent.

Handoff volume is instead set by how much children choose to write. Reducing it is a report-contract problem: denser reports, with the decision-relevant fields in the envelope where truncation cannot reach them.

## Reading these numbers later

A comparison cohort is only meaningful against similar task shapes. Continuations are frequently deliberate corrections rather than failures, and a clean exit is not evidence of correct work. The share-of-context figures convert bytes to tokens at a flat 4 bytes per token and are indicative only.
