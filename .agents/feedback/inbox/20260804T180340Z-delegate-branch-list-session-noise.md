# HF-20260804: Delegate branch listing mixes unrelated historical work

- **Status:** new
- **Observed date:** 2026-08-04
- **Source cwd/repo:** `/Users/nfrid/.pi/agent`
- **Task shape:** Long migration with several writable delegates and independent read-only audits
- **Harness component:** `delegate_branches list`
- **Route / attempt / outcome:** Listed branches to confirm cleanup after merging the current task's delegates; output included many branches and retired snapshots from unrelated earlier work
- **Observed cost / rework:** Made cleanup state noisy and required manually distinguishing six current branches from dozens of historical entries
- **Recurrence / confidence:** Observed in this task; likely recurring in long-lived harness repositories, medium-high confidence
- **Ticket:** —

## Behavior

`delegate_branches list` returned every retained branch and snapshot known for the repository, including unrelated historical tasks, rather than foregrounding branches created by the current agent session.

## Impact

The list stops being a useful picture of current outstanding work, increases the chance of dropping the wrong retained branch, and consumes substantial tool output in repositories with extensive delegate history.

## Evidence

At final cleanup, the list contained the six branches created during this migration alongside many earlier merged, unmerged, gone, and retired snapshot entries from unrelated tasks. Only the six current IDs needed action.

## Smallest improvement

Default `delegate_branches list` to entries created or touched in the current session, with an explicit option to include all repository history.
