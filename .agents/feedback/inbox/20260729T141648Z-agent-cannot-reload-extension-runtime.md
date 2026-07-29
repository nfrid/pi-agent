# HF-20260729: Agent cannot reload extension runtime after updating it

- **Status:** new
- **Observed date:** 2026-07-29
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Implement and live-verify fixes to Pi delegate extensions during an evaluation session
- **Harness component:** Extension runtime lifecycle and agent-accessible capabilities
- **Route / attempt / outcome:** Parent merged delegate extension fixes; focused tests passed, but the active session continued using the pre-change extension instance
- **Observed cost / rework:** Blocked same-session live verification of the refreshed-snapshot and completion-race fixes; required deferring operational checks until a manual reload or new session
- **Recurrence / confidence:** Deterministic for extension self-updates in an active session; high confidence
- **Ticket:** —

## Behavior

After the agent merged changes under `extensions/`, subsequent harness tool calls still used the extension code loaded at session start. Pi supports interactive `/reload`, but no agent-accessible reload capability was registered in this session, and tool contexts cannot invoke `ctx.reload()` directly.

## Impact

An agent maintaining the harness can implement and unit-test a runtime fix but cannot complete a same-session operational verification. This delays evaluation, requires user intervention or a replacement session, and can make a live retry exercise the known-old implementation.

## Evidence

The session reproduced a read-only snapshot refresh failure, merged its fix, and passed focused lifecycle tests. A live refreshed continuation was intentionally not retried because the parent runtime remained loaded from before the merge. Pi extension documentation states that auto-discovered extensions require `/reload` to load changes and that tools cannot call `ctx.reload()` directly.

## Smallest improvement

Provide a safe agent-callable way to request an extension reload as a follow-up action, with clear confirmation that future tool calls use the new runtime instance.
