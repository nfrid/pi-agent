# HF-20260802: Delegate continuation requires repeating the subagent name

- **Status:** triaged
- **Observed date:** 2026-08-02
- **Source cwd/repo:** `/Users/nfrid/.pi/agent` (Pi agent configuration repository)
- **Task shape:** Continue a writable implementation subagent with focused review feedback
- **Harness component:** `delegate` continuation parameter validation
- **Route / attempt / outcome:** A `luna-xhigh` continuation call supplied the continuation token and follow-up task but omitted `name`; validation rejected it. Repeating the existing subagent name allowed the continuation to proceed.
- **Observed cost / rework:** One failed tool call and a repeated continuation request with redundant identity data
- **Recurrence / confidence:** Observed once; high confidence it recurs whenever a continuation with `task` omits `name`
- **Ticket:** [HFM-20260802: Inherit delegate continuation display names](../tickets/20260802-inherit-delegate-continuation-name.md)

## Behavior

A continuation token preserves the child session, route, write capability, and isolation, but a follow-up call with `task` still fails unless the parent repeats `name`. The deterministic error was `Delegate name is required with task.` The parent then repeated the prior name and the same continuation succeeded.

## Impact

The continuation token already identifies the subagent lineage, so requiring its display name again creates avoidable validation failures and forces the orchestrator to retain and replay presentation metadata unrelated to the follow-up work.

## Evidence

- First continuation attempt: supplied the existing continuation token and focused follow-up task; result was `Delegate name is required with task.`
- Second attempt: added the prior name `Compact delegate handoffs`; the continuation launched successfully with the same token.
- Fresh task documentation describes `name` as required with `task`, while continuation fields otherwise inherit persisted route, write capability, and isolation.

## Smallest improvement

Allow a continuation call to omit `name` and reuse the lineage's existing display name. If the name is not currently persisted, persist it with the continuation session; keep `name` required only for fresh single-task delegation.
