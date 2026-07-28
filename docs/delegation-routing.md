# Delegation routing

Point-in-time routing results from the frozen [`delegation-metrics-2026-07-28.json`](delegation-metrics-2026-07-28.json) capture. The source was the same 59-session cohort described in [`delegation-baseline.md`](delegation-baseline.md).

Routing coverage is 221 unique runs with both a route and recorded child usage, out of 418 unique delegated runs. Older/unreported runs and repeated background report deliveries are intentionally outside this denominator. Provider-reported cost totals $76.61.

| Route | Relative cost | Routed tasks | Share | Turns/task | Cost/task | Total cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| terra-high | 8 | 93 | 42.1% | 8.1 | $0.292 | $27.13 |
| luna-low | 1 | 45 | 20.4% | 2.0 | $0.004 | $0.20 |
| luna-medium | 2 | 24 | 10.9% | 7.0 | $0.071 | $1.70 |
| terra-max | 13 | 24 | 10.9% | 18.1 | $1.380 | $33.12 |
| sol-medium | 15 | 20 | 9.0% | 7.5 | $0.467 | $9.34 |
| luna-high | 5 | 9 | 4.1% | 11.0 | $0.178 | $1.60 |
| sol-high | 21 | 4 | 1.8% | 4.5 | $0.738 | $2.95 |
| luna-max | 7 | 2 | 0.9% | 15.5 | $0.287 | $0.57 |
| **All routed runs** | | **221** | | **7.9** | **$0.347** | **$76.61** |

`terra-max` accounts for 10.9% of routed tasks and 43.2% of reported spend. That concentration is a candidate for later review, not proof that the route is wrong: this capture has no usable task-quality outcome coverage. `luna-low` handles 20.4% of routed tasks for 0.3% of spend, which describes allocation, not correctness.

No routed escalation or de-escalation was observed. The denominator is all 107 continuation calls, including parallel continuation calls; zero therefore means the escalation path was unobserved here, not that it failed or succeeded. Compare route shares, turns, and cost only across similar task shapes.
