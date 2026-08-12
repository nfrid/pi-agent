# HF-20260812: Settled delegate history disappears on the next user message

- **Status:** new
- **Observed date:** 2026-08-12
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Inspect a completed delegate's thinking and tool details from the dashboard after discussing its result.
- **Harness component:** Delegate live status lifecycle / dashboard surface
- **Route / attempt / outcome:** A `luna-low` diagnostic delegate completed successfully with rich transcript data; its row was no longer present after the next user message.
- **Observed cost / rework:** Made a working transcript fix look like a new regression and prevented post-result inspection in the same conversation.
- **Recurrence / confidence:** Deterministic lifecycle behavior; high confidence.
- **Ticket:** —

## Behavior

Once a settled delegate result has entered the parent and the parent settles, the delegate status lineage is armed for deletion. The next user message calls `parentUserMessage()` and removes it from the dashboard surface.

## Impact

The natural moment to ask about or inspect a completed delegate is after its result is discussed. Clearing the row on that message removes the transcript exactly when the user expects to open it, and the empty surface is indistinguishable from failed delegate reporting.

## Evidence

- `extensions/delegate/status.ts` marks entered settled lineages with `clearOnNextUserMessage` and deletes them in `parentUserMessage()`.
- `extensions/delegate/index.ts` invokes that method for the next parent user message.
- The dashboard snapshot showed a completed delegate with thinking and tool payloads in its owning runtime, then zero delegate rows after the follow-up message.

## Smallest improvement

Retain a bounded number of successful settled delegate rows across subsequent user messages, with an explicit history cap or manual clear action, instead of deleting the lineage on the first follow-up.
