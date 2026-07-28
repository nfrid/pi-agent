# Delegation baseline

Captured 2026-07-28 from `sessions/`, before any change to the handoff contract or caps. Reproduce with:

```bash
npm run --silent session:metrics -- summarize sessions --min-delegate-calls 1
```

Cohort: 59 sessions with at least one delegate call, 329 calls, 422 tasks that ran.

Restated twice as the instrument was corrected. `07e22be` stopped charging each background acknowledgement with tasks it had not yet done, and started counting the report the job later delivered. The follow-up caught the larger half of the same blind spot: a finished background job is normally *pushed* to the parent as a steering message, and only reaches a `delegate_jobs` result when the parent peeks — so the main delivery path was still invisible. The summarize command reports cohort totals; the per-result percentiles below come from a separate pass over the same corpus applying the same counting rules.

## What a handoff costs the parent today

| Measurement | Value |
| --- | --- |
| Handoff bytes per task (cohort) | 2,421 B |
| Single-result bytes | p50 1,333 B, p90 4,815 B, p99 7,368 B, max 9,734 B |
| Parallel aggregate bytes | p50 6,756 B, p90 20,453 B, max 26,078 B |
| Truncation rate | 0.24% (1 task of 422) |
| Continuation rate | 29.8% of calls |
| Parallel calls | 60 of 329 |
| Writable tasks | 18 of 422 |
| Rejected calls (no run launched) | 19 |
| Background jobs started / delivered | 10 / 21 |
| Handoff tokens as a share of peak request context | p50 3.4%, p90 18.2%, max 23.0% |

## The caps do not bind

At the time of capture `PARENT_HANDOFF_CAPS` allowed 12 KiB for a single result, 8 KiB per task in a parallel fan, and 50 KiB aggregate. Nothing in this cohort reached any of them: the largest single result is 9,734 B and the largest parallel aggregate is 26,078 B, and the one truncated task in 422 is the whole of the truncation rate.

The caps have since moved to 6 / 4 / 16 KiB. Against this corpus that clips 4.2% of single results for 1.0% of all handoff bytes, and 13.1% of parallel fans for 4.8%. The aggregate is the binding one, and a cap change alone still cannot produce a material reduction in what delegation costs the parent.

Handoff volume is instead set by how much children choose to write. Reducing it is a report-contract problem: denser reports, with the decision-relevant fields in the envelope where truncation cannot reach them.

## Reading these numbers later

A comparison cohort is only meaningful against similar task shapes. Continuations are frequently deliberate corrections rather than failures, and a clean exit is not evidence of correct work. The share-of-context figures convert bytes to tokens at a flat 4 bytes per token and are indicative only.
