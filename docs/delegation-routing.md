# Delegation routing

Captured 2026-07-28 from `sessions/`, alongside `docs/delegation-baseline.md`. Reproduce with:

```bash
npm run --silent session:metrics -- summarize sessions --min-delegate-calls 1
```

and read `cohort.routes`.

Where the baseline asks what a handoff costs the parent's context, this asks what the work costs to run, and whether it is landing on the right rung of `delegate.modelCatalog`.

Coverage: 224 of the cohort's 422 tasks carry a `routing` record. The rest predate the field, so treat the shares as a sample of recent behaviour rather than a full census. Costs are provider-reported.

## Where the work goes, and where the money goes

| Route | Relative cost | Tasks | Share | Turns/task | Cost/task | Total cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| terra-high | 8 | 92 | 41.1% | 8.0 | $0.289 | $26.62 |
| luna-low | 1 | 48 | 21.4% | 1.8 | $0.004 | $0.18 |
| terra-max | 13 | 25 | 11.2% | 17.4 | $1.325 | $33.12 |
| luna-medium | 2 | 24 | 10.7% | 7.0 | $0.071 | $1.70 |
| sol-medium | 15 | 20 | 8.9% | 7.5 | $0.467 | $9.34 |
| luna-high | 5 | 9 | 4.0% | 11.0 | $0.178 | $1.60 |
| sol-high | 21 | 4 | 1.8% | 4.5 | $0.738 | $2.95 |
| luna-max | 7 | 2 | 0.9% | 15.5 | $0.287 | $0.57 |
| **All** | | **224** | | **4.1** | **$0.180** | **$76.08** |

Three things stand out.

**`terra-max` is 11% of the tasks and 44% of the spend.** At 17.4 turns and $1.33 a task it is more than twice as expensive per task as anything else and four and a half times `terra-high`. If there is a routing economy lever, it is this one row — and Phase 3 already found the matching failure mode, where a `terra-max` repo-wide audit ran into the 600 s delegate timeout on both arms. Long-running top-route tasks are where cost and failure meet.

**`luna-low` triage works.** 21% of tasks at 1.8 turns and $0.004 each, for $0.18 across the whole cohort. Cheap routes are being used for cheap questions rather than being avoided, which is the behaviour the catalog exists to produce.

**The middle is thin.** `luna-medium` and `luna-high` together take 15% of tasks. The distribution is barbelled: cheap triage at one end, `terra-high`/`terra-max` at the other, with `terra-high` alone absorbing 41%. That is the shape you get when a route is chosen as a safe default rather than fitted to the task.

## Escalation is never used

`Exceeded:` exists so a child can report that a task outran its route without naming a rung it cannot see, and the parent can then resume that same child on a stronger route — its session intact, so the exploration is not paid for twice. That path is the reason the contract has the field at all.

**It has never been taken.** Across 65 continuations whose original route could be identified, the route changed zero times: every continuation reused the route it was already on. One genuine `Exceeded:` line appears in the corpus and was not escalated.

Read this carefully. Most of the corpus predates the Phase 2a contract (`8e74efa`), so children mostly had no `Exceeded:` field to report a shortfall with, and the parent had little to act on. The honest reading is that the escalation path is **unexercised**, not that it is broken — `delegateEscalationRate` now exists to watch whether the contract changes that.

## Reading these numbers later

Cost per task is not a quality measure, and a cheap route that returns a wrong answer the parent then has to redo is the expensive option. Turns per task is the better proxy for whether a route was suited to its task: a route consistently running long is either under-powered for what it is being given or being given tasks that should have been split.

Route shares reflect what the parent was asked to do in this corpus. A cohort of mostly-audit sessions will barbell differently from a cohort of mostly-implementation ones, so compare shares only across similar task shapes.
