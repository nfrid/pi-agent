# HFM-20260806: Report actionable delegate lifecycle failures

- **Status:** proposed
- **Approval:** approved 2026-08-06
- **Created:** 2026-08-06
- **Source reports:** [HF-20260806: Delegate lifecycle failures lack actionable diagnostics](../inbox/20260806T093756Z-opaque-delegate-lifecycle-failures.md)
- **Implementation dependency:** Implement after [HFM-20260805: Add schema-driven delegate outputs](20260805-add-schema-driven-delegate-outputs.md) lands, reusing its validated structured-result and artifact primitives

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

Errored and aborted delegates can settle without enough information for the parent to choose between continuing, retrying, changing the task, changing the route, or investigating infrastructure. A generic lifecycle label or clipped exception defeats delegation's context-saving purpose and prompts duplicate manual work.

## Baseline

The report records two read-only `luna-xhigh` research attempts: one returned `Status: error` with no outcome or conclusion and an exception truncated inside the runner; another returned `Status: aborted` with no cause, outcome, or conclusion. The implementation confirms the gap: `extensions/delegate/runner.ts` maps an aborted signal to the generic `Delegated task was aborted.`, while `extensions/delegate/output.ts` clips failure text to 120 characters. Existing schema-driven output work concerns successful task-result contracts and does not classify harness lifecycle failures.

## Hypothesis

If every non-successful delegate settlement uses the structured-output foundation to expose harness-authored lifecycle metadata—a stable observed reason code, one complete bounded diagnostic or exact artifact reference, and the availability of continuation context and retained worktree state—then the parent can make a deterministic recovery choice without repeating the delegated investigation manually. This is falsified if a tested failure still requires inferring its observed cause or whether recovery resources exist.

## Guardrails

- Implement after the schema-driven delegate-output foundation lands; reuse its validation, parent-projection, artifact ownership, and bounded-output primitives rather than creating a second result protocol.
- Keep lifecycle metadata harness-authored and separate from the child's task-result schema so child prose or structured output cannot spoof failure state.
- Derive reason codes from observed harness lifecycle state; do not guess provider or infrastructure causes that are not known.
- Preserve bounded parent-visible output and provide an owned exact artifact handle when a useful diagnostic exceeds that bound.
- Do not require or imply a speculative `retryable` judgment; expose factual continuation, branch, and snapshot availability instead.
- Do not broaden diagnostic capture to wholesale raw stderr or claim new secret-redaction guarantees.
- Preserve successful-result behavior and legacy prose fallback established by the schema-driven output ticket.
- Keep user cancellation, queue cancellation, timeout, child exit, provider error, setup failure, and harness lifecycle failure distinguishable where the harness has evidence.

## Options considered

1. **Harness-authored lifecycle object using the structured-output foundation:** Supports deterministic recovery while sharing validated projections, bounded artifacts, and ownership rules; requires sequencing after that foundation lands.
2. **Independent structured failure protocol:** Could ship sooner, but duplicates result validation and artifact semantics and risks two incompatible delegate contracts.
3. **Increase the current failure-text clip:** Preserves more prose but still does not classify observed cause or retained context.
4. **Always retain and expose raw stderr:** Maximizes forensic detail but can be large, sensitive, and still ambiguous about lifecycle and recovery state.

## Recommendation

Implement option 1 after schema-driven delegate outputs land. Add a small harness-authored lifecycle object alongside the child result, with a stable observed reason code, bounded actionable diagnostic or owned exact artifact, continuation availability, and retained worktree/snapshot availability. Do not add a `retryable` judgment: the parent can decide from factual lifecycle and resource state.

## Scope

- **In:** Harness-authored structured lifecycle metadata; delegate error/abort reason codes; diagnostic preservation; continuation and retained-resource availability; reuse of structured-output projection/artifact primitives; single, batch, foreground, and background rendering; failure fixtures.
- **Out:** A second result protocol; provider-specific root-cause inference without evidence; retryability judgments; automatic retries; route changes; child task-result schema design; removal of output limits; wholesale raw stderr exposure.

## Acceptance criteria

- [ ] Non-success lifecycle metadata uses the schema-driven output foundation's validated projection, artifact ownership, and output bounds rather than an independent protocol.
- [ ] Lifecycle metadata is authored from harness state and cannot be overridden or spoofed by child prose or structured task output.
- [ ] Every errored, aborted, and timed-out delegate result includes a stable observed reason code.
- [ ] Every non-success result includes one actionable diagnostic that is complete inline or available through an owned exact artifact handle, never silently clipped mid-message.
- [ ] Results state whether the same continuation retains usable child context and whether a writable branch or read-only snapshot was retained for inspection or recovery.
- [ ] User cancellation, queued cancellation, timeout, child nonzero exit, provider/runner error, setup failure, and lifecycle cleanup failure remain distinguishable whenever the harness observes the distinction.
- [ ] Unknown causes are labeled unknown rather than assigned a speculative reason or retryability judgment.
- [ ] Diagnostic capture remains bounded and does not expand to wholesale raw stderr.
- [ ] Single and parallel delegate calls expose the same lifecycle contract, including when the child task result is missing or invalid.

## Validation

After the schema-driven output implementation lands, inject user and queue cancellation, timeout, child nonzero exit, provider/runner exception, malformed or missing child structured output, setup failure, lifecycle cleanup failure, and unknown failure. Include long, multiline, and Unicode diagnostics. Assert reason codes, harness authorship, continuation/worktree state, owned artifact fallback, no mid-message clipping, bounded capture, and consistent single/batch behavior. Run focused delegate runner, lifecycle, structured-output, artifact, job, and tool tests, then `npm run check`.

## Evaluation

- **Window:** After an approved merge, the first 20 non-successful delegate runs including at least 5 aborts and 5 provider, runner, setup, or lifecycle failures, or 2026-10-15, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline of two unclassified failures that forced manual repetition. Keep only if every evaluated run has a truthful harness-authored reason code and recovery-resource state, no diagnostic is silently clipped, and the parent can choose retry, continue, inspect, or stop without separate lifecycle forensics.

## Implementation and resolution

- **Approved implementation:** After schema-driven delegate outputs land, reuse their validated projection and owned-artifact primitives for harness-authored non-success lifecycle metadata containing an observed reason code, complete bounded diagnostic or exact artifact, and factual continuation/branch/snapshot availability. Do not add a speculative retryability judgment or a second result protocol; approved 2026-08-06.
- **Merged change:** —
- **Resolution:** pending evaluation
