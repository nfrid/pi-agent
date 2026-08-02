# HFM-20260802: Announce background-delegate waiting before yielding

- **Status:** approved
- **Approval:** approved 2026-08-02
- **Created:** 2026-08-02
- **Source reports:** [HF-20260802: Background delegate waiting emits an empty assistant final](../inbox/20260802T120154Z-background-delegate-empty-final.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

The delegate workflow explicitly tells the parent to end its turn when no independent work remains and rely on automatic completion. If the parent does so without final text while a background delegate is still running, the harness exposes an empty assistant response before the delegate completion starts the continuation. Users see an apparent blank completion even though the task is intentionally waiting and will resume automatically.

## Baseline

The source report records one intentional yield with one outstanding `luna-high` read-only background review. The conversation emitted one empty assistant final, then later delivered the delegate completion and resumed work: 1 blank user-visible response in 1 observed intentional background yield. Recurrence beyond this observation is not yet measured.

The local delegate extension instructs the agent to end the turn when no independent work remains (`extensions/delegate/tool.ts`) and only calls `pi.sendMessage(..., { deliverAs: 'steer', triggerTurn: true })` after a job settles (`extensions/delegate/index.ts`). Pi 0.82.1 emits and persists finalized assistant messages before `agent_settled`; its documented `message_end` extension hook can replace a finalized message only with another message of the same role. There is no documented extension result that suppresses an assistant message or marks it as an internal yield. Existing local tests verify automatic completion delivery, but do not cover the user-visible response between launch and settlement.

This differs from HFM-20260729, which deduplicates a completed job returned through both inspection and automatic delivery. Here the problematic message contains no job result and occurs before completion.

## Hypothesis

If delegate guidance tells the parent to emit one concise waiting status before ending a turn with outstanding background work, then intentional yields will no longer look like abandoned tasks, because users will see that independent work is complete, final work is still pending, and automatic resumption is expected.

## Guardrails

- Describe the task as waiting or still in progress; do not claim the overall task is done while a required delegate result remains pending.
- Emit at most one concise waiting status per yield; do not repeat status messages while the same completion is outstanding.
- Preserve automatic completion delivery, batching, stable job IDs, retained inspection results, and current peek/cancel deduplication.
- Continue to prohibit polling merely to wait; `peek` remains for deliberate inspection or a decision-changing bounded timeout.
- Do not change Pi host message persistence or rendering, completion content, or background-job lifecycle.

## Options considered

1. **Guide the parent to announce waiting once:** Solves the observed blank response through a localized prompt change, accurately communicates pending work, and requires no host lifecycle API.
2. **Coordinate deferred final delivery with delegate lifecycle state:** Could make waiting invisible, but requires host/extension suppression semantics and risks a silent indefinite wait if resumption fails.
3. **Hide empty assistant components in the TUI:** Removes a blank row only in one interface while leaving RPC output and session history unchanged.
4. **Poll until completion:** Avoids yielding but wastes turns and conflicts with existing background-job guidance.

## Recommendation

Implement option 1. When no independent work remains, tell the user once that independent work is complete, the background delegate is still pending, and work will resume automatically. Then end the turn without polling. Keep the wording concise and avoid saying the overall task is done.

## Scope

- **In:** Delegate launch guidance, orchestration instructions, and focused assertions that require a concise waiting status before yielding.
- **Out:** Host message suppression, TUI rendering, session persistence, background process tools, completion content or batching, job scheduling, polling, and duplicate-result delivery.

## Acceptance criteria

- [ ] Background delegate launch guidance tells the parent to emit one concise user-visible waiting status when no independent work remains, then end the turn.
- [ ] Guidance says the task is still pending and will resume automatically; it does not instruct the parent to claim the overall task is done.
- [ ] Guidance continues to prohibit `delegate_jobs peek` merely to wait and preserves deliberate-inspection and decision-changing-timeout uses.
- [ ] Automatic completion behavior and existing lifecycle tests remain unchanged.
- [ ] Focused tests reject the prior bare “end the turn” guidance and assert the new waiting-status requirement.

## Validation

- Update focused delegate tool/prompt assertions for single and batched background launches.
- Run the focused delegate async and tool-description tests, then `npm run check`.
- During evaluation, compare user-visible empty responses per intentional background yield with the baseline of 1/1 and watch for repeated waiting messages, premature “done” claims, polling, or missing automatic resumptions.

## Evaluation

- **Window:** not started. After approved implementation, 20 intentional background yields including at least 5 batched yields and 5 failure/cancel/timeout cases, or 2026-08-16, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

## Implementation and resolution

- **Approved implementation:** Revise background-delegate guidance so that when no independent work remains, the parent emits one concise user-visible waiting status and ends the turn. Preserve automatic completion and no-poll behavior; do not implement host-level message suppression. Approved 2026-08-02.
- **Merged change:** —
- **Resolution:** pending evaluation
