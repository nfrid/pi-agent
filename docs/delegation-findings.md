# Delegation findings

These are review candidates from the point-in-time aggregate in [`delegation-metrics-2026-07-28.json`](delegation-metrics-2026-07-28.json). They are not approved routing policy or a claim of task quality: 417 of 418 runs have no reported capability outcome.

## 1. Outcome reporting is not yet observable at cohort scale

**Evidence.** The capture records 1 `done`, 0 `partial`, 0 `blocked`, and 0 `failed` report outcomes; 417 runs are `delegateOutcomeUnreported`. It does record 10 process errors, 11 timeouts, and 2 aborts, but process state cannot say whether useful work was completed.

**Candidate.** Keep the report contract and measure a later cohort. Do not infer a success rate from clean exits or alter scheduling/budgets to compensate for missing evidence.

**Validation.** A post-contract cohort should materially reduce `delegateOutcomeUnreported` and make outcome/process state readable together.

## 2. `terra-max` deserves outcome-backed review, not a cost-only intervention

**Evidence.** `terra-max` is 24 of 221 routed runs (10.9%) and $33.12 of $76.61 reported spend (43.2%), with 18.1 turns and $1.380 per routed run.

**Candidate.** Review task fit only after outcome coverage exists. The frozen data supports concentration, not a conclusion that the route is overused, underpowered, or ineffective.

**Validation.** Compare task shape, outcome, timeout, and reroute behavior in a later comparable cohort.

## Feedback ownership

The original proposal intended a reviewed `~/job` feedback loop. The destinations are deliberately split:

1. **Local implementation findings stay in this repository.** Delegate-extension defects, metric semantics, report lifting, and their tests/docs are owned and fixed here.
2. **Cross-session orchestration or workspace-workflow patterns observed while doing `~/job` work go to `~/job`'s reviewed inbox.** Use that repository's feedback procedure there.

This branch does not edit `~/job`, and no automatic integration with its inbox is claimed. The rule routes future observations; it does not reclassify local extension fixes as workspace feedback.
