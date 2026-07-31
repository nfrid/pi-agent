# HFM-20260731: Add a pre-timeout delegate checkpoint

- **Status:** parked
- **Approval:** not approved
- **Created:** 2026-07-31
- **Source reports:** [HF-20260731: Writable delegate timeout has no clean checkpoint window](../inbox/20260731T085516Z-delegate-timeout-checkpoint.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

A writable delegate reached its hard runtime limit with a committed partial file containing a literal `EOF` marker and embedded tool-call text. Retention and continuation recovered the work, but the malformed commit required forensic review and contributed to a later clean-history replay.

## Baseline

One Luna xhigh run timed out after 1800 seconds. Its retained branch had three changed paths and commit `a6e6474`; review exposed malformed content in `src/cli/output.ts`, and a continuation repaired it.

The harness already tells every child its approximate maximum runtime and to reserve time for partial findings (`extensions/delegate/prompt.ts`). At the limit, `extensions/delegate/delegate-child.ts` sends `SIGTERM` immediately and `SIGKILL` after a short process grace period; it sends no earlier in-band checkpoint instruction. Worktree settlement intentionally retains timed-out changes for recovery. The evidence therefore shows one failure despite an existing up-front warning, but does not yet establish whether a second warning, a longer runtime, auto-commit behavior, or child editing discipline is the causal control.

## Hypothesis

If writable children receive an actionable checkpoint signal shortly before hard timeout, then they may stop edits and leave syntactically inspectable partial work. This remains an assumption: a child busy in a tool call may not process the signal, and extending runtime can simply move the same boundary.

## Guardrails

- Never discard timed-out work automatically or present partial work as complete.
- Preserve hard termination and bounded resource use even if checkpoint handling fails.
- Do not auto-commit an invalid or dirty tree merely to create a checkpoint.
- Do not treat a signal acknowledgement as validation; retained work still requires review.
- Avoid adding a general scheduler, transcript capture, or route-policy change.

## Options considered

1. **Keep the current up-front deadline warning and retention:** No added lifecycle complexity; one malformed timeout remains possible.
2. **Send an in-band pre-timeout checkpoint request:** May improve partial state but needs a reliable child communication path, reserved grace, and evidence that the child can respond while active.
3. **Increase route timeouts:** Delays the boundary without ensuring clean settlement and raises cost.
4. **Run automatic syntax checks or commits at timeout:** Language-specific and risks blessing malformed work without child context.

## Recommendation

Park option 2 pending recurrence and a small feasibility design. Reconsider after either two additional writable timeouts leave malformed/unreviewable state despite the existing prompt, or a deterministic child-control mechanism can demonstrate delivery, acknowledgement, bounded grace, and hard-stop fallback without extending every run materially.

## Scope

- **In:** Future feasibility of one pre-timeout checkpoint request and bounded grace for writable delegates.
- **Out:** Implementation now; route timeout changes; language-specific validation; automatic commits; removal of retained recovery branches.

## Acceptance criteria

- [ ] A writable test child receives a checkpoint request before hard timeout and has a bounded opportunity to return a partial result or stop editing.
- [ ] An unresponsive child is still terminated at a documented hard deadline.
- [ ] Timeout settlement distinguishes acknowledged clean checkpoint, unacknowledged retained partial work, and ordinary successful completion without claiming validation.
- [ ] Existing timed-out branch retention and continuation recovery remain available.
- [ ] Read-only and normally completing delegates incur no material lifecycle regression.

## Validation

Before approval, prototype with deterministic child fixtures for acknowledged checkpoint, active tool call, ignored signal, process exit during grace, and forced kill. If approved later, add prompt/control, process, lifecycle, worktree-retention, output, and continuation tests, then run `npm run check`.

## Evaluation

- **Window:** Not started; if implemented after reconsideration, first 10 checkpoint-eligible timeouts or 2026-10-31, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare malformed retained trees and recovery effort with the one observed timeout. Keep only if checkpoint delivery is observable, hard deadlines remain bounded, and malformed retained state decreases without hiding partial work. Fewer than 3 eligible timeouts is `insufficient evidence`.

## Implementation and resolution

- **Approved implementation:** —
- **Merged change:** —
- **Resolution:** pending evaluation
