# HFM-20260729: Deduplicate peeked delegate completions

- **Status:** proposed
- **Approval:** approved 2026-07-29
- **Created:** 2026-07-29
- **Source reports:** [HF-20260729: Delegate completion is delivered twice after a settling peek](../inbox/20260729T103915Z-duplicate-delegate-completion.md)

## Problem

A terminal background delegate result can enter the parent context once through `delegate_jobs peek` and again through automatic completion delivery. Duplicate large handoffs waste context and can be mistaken for independent evidence.

## Baseline

The report records one job whose complete handoff was returned by a bounded `peek` and immediately delivered again automatically. Current source already suppresses `onSettled` while a waiting peek observes settlement (`extensions/shared/runtime/registry.ts`), and `extensions/delegate/jobs.test.ts` covers that ordering. However, a result queued for the completion timer just before a peek is not removed by `onResultEntered`; `pendingCompletions` in `extensions/delegate/index.ts` can therefore retain and later deliver the same job. This leaves a falsifiable near-settlement race consistent with the observation. Recurrence frequency is unknown.

## Hypothesis

If a terminal `peek` or `cancel` removes that job ID from a completion wave that is queued but not yet flushed, then the queued automatic copy will not enter the parent context after the tool result, because JavaScript processes the inspection callback and timer flush serially. The existing observer mechanism already suppresses automatic queueing when a bounded peek is waiting at the moment of settlement.

## Guardrails

- Preserve automatic delivery when no terminal result has been returned by `peek` or `cancel`.
- A nonterminal peek must not suppress later completion.
- Preserve stale-branch notifications and batched/partial completion waves for other jobs.
- Deduplicate by stable job ID, not by handoff text.
- Keep terminal results available for later inspection even after delivery; suppress only a queued automatic copy when explicit inspection wins the race.
- If automatic delivery has already occurred, a later explicit peek still returns the retained result; changing that behavior is out of scope.

## Options considered

1. **Remove matching jobs from `pendingCompletions` on terminal peek or cancel:** Directly addresses the observed timer race without adding durable lifecycle state; a timer flush already running cannot interleave with the callback.
2. **Track consumed job IDs in the completion coordinator:** Can express a broader once-only policy, but adds state and pruning without improving the serial pre-flush race covered here.
3. **Document that peek may duplicate delivery:** No implementation risk, but retains the context cost and violates the tool guidance that bounded waiting is supported.

## Recommendation

When `delegate_jobs` returns terminal results through `peek` or `cancel`, remove those current-epoch job IDs from `pendingCompletions` before the timer can flush. Reuse the existing observer suppression for jobs that settle while a bounded peek is already waiting; do not add a second durable delivery-state registry.

## Scope

- **In:** Terminal `peek`/`cancel` versus automatic-delivery races; pending completion waves; focused ordering tests.
- **Out:** Changing delegate result content, removing retained job results, altering completion batching, or deduplicating similar reports from different jobs.

## Acceptance criteria

- [ ] A job that settles while a bounded peek is waiting is returned by the peek and is not queued for automatic delivery.
- [ ] A job that queues automatic delivery and is then returned by a terminal peek before the timer flush is removed from that wave.
- [ ] A nonterminal peek does not prevent the eventual automatic completion.
- [ ] Inspecting one job does not suppress uninspected siblings in the same completion wave.
- [ ] A result already delivered automatically remains available to a later explicit peek.
- [ ] Stale-branch completion behavior remains covered and unchanged.

## Validation

- Add deterministic fake-timer tests for both sides of the settlement/peek race and for mixed consumed/unconsumed completion waves.
- Assert job IDs, tool results, and `pi.sendMessage` calls rather than comparing report text.
- Run the focused delegate async/job tests, then `npm run check`.
- During the evaluation window, compare duplicate completion observations per terminal peek with the baseline of one confirmed duplicate; also watch for missing automatic completions.

## Evaluation

- **Window:** First 30 background jobs inspected with `peek`, or 14 days after merge, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

## Implementation and resolution

- **Approved implementation:** Remove terminal peek/cancel results from queued current-epoch completion waves, with focused ordering and sibling tests; approved 2026-07-29.
- **Merged change:** —
- **Resolution:** pending evaluation
