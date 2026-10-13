# HFM-20260812: Preserve oversized delegate events for recovery

- **Status:** evaluation-pending
- **Approval:** approved by the user on 2026-10-02
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

- [x] An event exceeding the current transport limit produces an explicit overflow reason and never disappears without a bounded diagnostic.
- [x] Exact overflow bytes are retained in an owner-session artifact when capture is safe, without entering parent model context inline.
- [x] Transcript/result validation remains authoritative; overflow does not convert invalid or incomplete output into success.
- [x] Direct and hosted runs publish the same bounded recovery projection through the shared handoff path; existing batch and continuation contracts pass. The current report contract is prose plus bounded metadata, not the historical selectable structured-result API.
- [x] Artifact publication failure is reported distinctly and still leaves a bounded diagnostic.
- [x] Events below the limit retain current behavior and output bounds, including normal events after overflow capture consumes its budget.

## Validation

Inject oversized direct and hosted events, including malformed UTF-8, multibyte text, CRLF, sensitive fixture markers, and events clipped by the encoded record envelope. Verify artifact ownership and exact bytes, absence of artifact-only content from parent projections, truthful lifecycle status, publication-failure fallback, capture-budget exhaustion, and normal events after overflow. Run focused delegate child/lifecycle/output tests, host/store tests, background-jobs client and contribution-schema tests, then `bun run check` for the shared protocol change.

Completed 2026-10-02:

- Child focused checks: 74 delegate tests, 26 host/store tests, 9 background-jobs client tests and 8 contribution tests passed. Child full check passed before the final separator-cap correction; the corrected lifecycle suite then passed all 19 tests with changed-path Biome clean.
- Parent reviewed the full retained delta and squashed it as `fdb5e7cbcb9c`. Parent `PATH="$PATH:/usr/sbin:/sbin" bun run check` passed after the final correction, including all typecheck scopes, lint and root/workspace tests. Log: `/tmp/pi-overflow-parent-check-fdb5e7cb.log`.
- The historical baseline is the linked observed report plus inspected discard code. No clean pre-edit baseline test run or live oversized recovery was performed; regression fixtures are not live evaluation evidence.
- Capture is capped at 8 MiB per hosted job and delegate artifact; unavailable capture/publication is explicit. Cancellation and timeout retain precedence. No event-size limit was raised.
- No live deployment, parent package rebuild, or process-host restart was performed. Hosted exact capture needs the new process-host build; older hosts remain diagnosable but cannot recover bytes they already discarded.

Activated 2026-10-13:

- Built and validated exact commit `299e20a142c2` with `bun run workspace:build`, `bun run check` and two focused Diagnostics/delegate Playwright tests. Deployed its workspace bundles and restarted the process host only after verifying zero active jobs.
- Process-host PID `34365` replaced `57725`; runtime-host PID `46366` remained unchanged. The new host answered its capabilities request. A consistent telemetry backup and previous bundles were retained before deployment.
- No live overflow recovery was performed. Regression checks do not establish the post-activation evaluation result. Already-open Pi sessions still need extension reload or replacement before their callbacks can participate in this evaluation.

## Evaluation

- **Window:** Process-host activated on 2026-10-13. Using reloaded or new Pi sessions, observe the first 10 delegate overflow or near-limit fixtures/live events, including at least 3 real overflow recoveries, or 2026-10-31, whichever is later. Pre-activation regression fixtures do not fill this window.
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline of two attempts and zero recoverable findings. Keep only if every overflow has a truthful bounded reason, no retained payload leaks inline or across owners, and at least 3 real overflow cases can be inspected without repeating the delegated investigation.

## Implementation and resolution

- **Approved implementation:** Option 1, explicitly approved by the user on 2026-10-02. Preserve oversized delegate event bytes outside model context and expose bounded recovery metadata.
- **Merged change:** `fdb5e7cbcb9c` — `fix(delegate): preserve oversized event recovery artifacts`.
- **Resolution:** Source implementation, parent validation and live process-host activation complete; post-activation evaluation remains pending. Existing Pi sessions require extension reload or replacement to use the updated callbacks. No successful live overflow recovery is claimed.
