# HFM-20260812: Preserve oversized delegate events for recovery

- **Status:** proposed
- **Approval:** not approved
- **Created:** 2026-08-12
- **Source reports:** [HF-20260809: Delegate result overflow discards the entire diagnosis](../inbox/20260809T134842Z-delegate-result-overflow-discard.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

A delegate transport event that exceeds the runner's event-size limit can be discarded wholesale. The parent receives lifecycle failure metadata but cannot recover the child's diagnosis, so even a deliberately concise continuation may require repeating the investigation.

## Baseline

The source report records one `luna-xhigh` diagnosis whose JSON event exceeded 1,048,576 bytes and was discarded, followed by a continuation constrained to 300 words that aborted without a result. No files changed and no result artifact was available, so two completed attempts yielded no recoverable task evidence. The current lifecycle contract preserves bounded harness diagnostics and recovery state, while `extensions/delegate/events.test.ts` verifies bounded live projections; neither establishes that an oversized raw child event is retained before the transport drops it.

## Hypothesis

If an oversized delegate event is captured into an owner-session artifact before its inline projection is rejected, then the parent can recover bounded task evidence or diagnose the overflow without repeating the child investigation, because the transport limit will constrain parent context rather than destroy the only copy.

## Guardrails

- Keep all parent-visible event and completion projections bounded.
- Preserve artifact ownership, content-class checks, and untrusted-evidence framing.
- Do not treat a truncated or unvalidated structured result as successful.
- Do not increase the event limit as the primary fix or inject the oversized payload into model context.
- Preserve cancellation, timeout, and lifecycle reason semantics.
- If the payload cannot safely be parsed, retain exact bounded diagnostics rather than claiming recoverable task output.

## Options considered

1. **Artifact oversized events before bounded projection:** Preserves exact evidence without expanding parent context; requires capture at or before the current discard boundary.
2. **Raise the event-size limit:** Delays recurrence and increases memory/context risk without preventing destructive overflow.
3. **Return only an overflow reason:** Keeps output small but leaves the completed diagnosis unrecoverable, matching the current failure cost.

## Recommendation

Implement option 1. On event overflow, store the exact event bytes in an owner-session artifact when safe, return an explicit overflow lifecycle reason plus artifact handle, and derive only a bounded non-success envelope inline. If a valid task result can be extracted within existing validation rules, expose it normally; otherwise keep the run non-successful and recoverable rather than silently discarding its evidence.

## Scope

- **In:** Oversized delegate event capture; owned artifact fallback; explicit overflow lifecycle metadata; bounded inline rendering; single, batch, foreground, background, and continuation behavior.
- **Out:** Larger default event limits; accepting malformed structured results; automatic retries; semantic summarization of arbitrary payloads; cross-owner artifact access.

## Acceptance criteria

- [ ] An event exceeding the current transport limit produces an explicit overflow reason and never disappears without a bounded diagnostic.
- [ ] Exact overflow bytes are retained in an owner-session artifact when capture is safe, without entering parent model context inline.
- [ ] Structured-result validation remains authoritative; overflow does not convert invalid or incomplete output into success.
- [ ] Legacy prose and structured delegates expose consistent recovery metadata in foreground, background, single, batch, and continuation paths.
- [ ] Artifact publication failure is reported distinctly and still leaves a bounded diagnostic.
- [ ] Events below the limit retain current behavior and output bounds.

## Validation

Inject just-under-limit and over-limit JSON events containing prose results, structured results, malformed data, multibyte text, and sensitive fixture markers. Verify artifact ownership and exact bytes, absence of artifact-only content from parent projections, truthful lifecycle status, continuation behavior, and publication-failure fallback. Run focused delegate event, runner, output, artifact, lifecycle, and async tests, then `pnpm run check`.

## Evaluation

- **Window:** Not started; after an approved merge, the first 10 delegate overflow or near-limit fixtures/live events, including at least 3 real overflow recoveries, or 2026-10-31, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline of two attempts and zero recoverable findings. Keep only if every overflow has a truthful bounded reason, no retained payload leaks inline or across owners, and at least 3 real overflow cases can be inspected without repeating the delegated investigation.

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
