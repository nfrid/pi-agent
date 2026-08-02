# HF-20260802: Background delegate waiting emits an empty assistant final

- **Status:** triaged
- **Observed date:** 2026-08-02
- **Source cwd/repo:** `/Users/nfrid/code/evosoup`
- **Task shape:** Autonomous repository optimization with a final independent background review
- **Harness component:** Background delegation lifecycle / automatic completion
- **Route / attempt / outcome:** `luna-high` read-only review completed successfully after the parent ended its turn as instructed
- **Observed cost / rework:** A blank assistant response was emitted before the delegate completion resumed the task, creating a misleading apparent end of work
- **Recurrence / confidence:** Directly observed once; high confidence for turns that intentionally yield with a background delegate outstanding
- **Ticket:** [HFM-20260802: Announce background-delegate waiting before yielding](../tickets/20260802-suppress-background-yield-empty-final.md)

## Triage decision

Triaged as a distinct actionable lifecycle issue on 2026-08-02. Existing delegate tickets address duplicate completion delivery, batch result rendering, and reusable process backgrounding; none addresses the user-visible empty assistant message emitted while an outstanding delegate is expected to resume the task. The approved smallest change is to require one concise user-visible waiting status before yielding, while preserving automatic resumption and the prohibition on polling merely to wait.

## Behavior

When no independent parent work remained, the agent followed the harness instruction to end the turn and rely on automatic delegate completion. Ending that turn produced an empty assistant final before the delegate result arrived and resumed execution.

## Impact

Users can see an apparent blank completion while work is still running. This makes the task look abandoned or finished prematurely and encourages unnecessary user intervention.

## Evidence

The session started a background `luna-high` regression review, completed all independent checks, and ended the turn without polling. The conversation then contained an empty assistant final, followed by the automatically delivered delegate completion and resumed work.

## Smallest improvement

When background delegate jobs are still outstanding, treat an otherwise empty end-of-turn response as an internal yield: suppress the user-visible blank assistant message and resume on completion.