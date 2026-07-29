# HFM-20260729: Deduplicate peeked delegate completions

- **Status:** proposed
- **Approval:** not approved
- **Created:** 2026-07-29
- **Source reports:** [HF-20260729: Delegate completion is delivered twice after a settling peek](../inbox/20260729T103915Z-duplicate-delegate-completion.md)

## Problem

A terminal background delegate result can enter the parent context once through `delegate_jobs peek` and again through automatic completion delivery. Duplicate large handoffs waste context and can be mistaken for independent evidence.

## Baseline

The report records one job whose complete handoff was returned by a bounded `peek` and immediately delivered again automatically. Current source already suppresses `onSettled` while a waiting peek observes settlement (`extensions/shared/runtime/registry.ts`), and `extensions/delegate/jobs.test.ts` covers that ordering. However, a result queued for the completion timer just before a peek is not removed by `onResultEntered`; `pendingCompletions` in `extensions/delegate/index.ts` can therefore retain and later deliver the same job. This leaves a falsifiable near-settlement race consistent with the observation. Recurrence frequency is unknown.

## Hypothesis

If explicit inspection of a terminal job atomically marks its automatic completion as consumed, including removal from any pending completion wave, then each job handoff will enter the parent context at most once, because both settlement orderings share one delivery state keyed by job ID.

## Guardrails

- Preserve automatic delivery when no terminal result has been returned by `peek` or `cancel`.
- A nonterminal peek must not suppress later completion.
- Preserve stale-branch notifications and batched/partial completion waves for other jobs.
- Deduplicate by stable job ID, not by handoff text.
- Keep terminal results available for later inspection even after delivery; suppress only duplicate context injection.

## Options considered

1. **Track consumed job IDs in the completion coordinator:** Covers settlement-before-peek and peek-before-settlement orderings and can filter pending waves, but adds lifecycle state that must be pruned.
2. **Remove matching jobs only from `pendingCompletions` on terminal peek:** Small and directly addresses the observed timer race, but may miss a completion already entering the send path.
3. **Document that peek may duplicate delivery:** No implementation risk, but retains the context cost and violates the tool guidance that bounded waiting is supported.

## Recommendation

Use one job-ID-based consumed/delivered state in the completion coordinator. Mark a terminal result consumed when it is returned by `peek` or `cancel`, filter it from pending automatic waves, and mark automatic delivery through the same state.

## Scope

- **In:** Terminal `peek`/`cancel` versus automatic-delivery races; pending completion waves; focused ordering tests.
- **Out:** Changing delegate result content, removing retained job results, altering completion batching, or deduplicating similar reports from different jobs.

## Acceptance criteria

- [ ] A job that settles while a bounded peek is waiting enters the parent context once.
- [ ] A job that settles and queues automatic delivery immediately before a terminal peek enters the parent context once.
- [ ] A nonterminal peek does not prevent the eventual automatic completion.
- [ ] Consuming one job does not suppress unconsumed siblings in the same completion wave.
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

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
