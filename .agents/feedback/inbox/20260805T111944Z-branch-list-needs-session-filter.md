# HF-20260805: Delegate branch listing lacks a session-scoped view

- **Status:** new
- **Observed date:** 2026-08-05
- **Source cwd/repo:** /Users/nfrid/.pi/agent
- **Task shape:** Integrate several writable delegates, clean their worktrees, and verify no current delegation branches remain
- **Harness component:** delegate_branches list
- **Route / attempt / outcome:** Multiple successful Luna writable/read-only delegates / final branch inventory
- **Observed cost / rework:** The final inventory returned dozens of historical branches and snapshots unrelated to the current session, obscuring the current cleanup state and consuming output context.
- **Recurrence / confidence:** Deterministic for repositories with retained delegate history; high confidence.
- **Ticket:** —

## Behavior

`delegate_branches(action="list")` returned all retained historical branch and snapshot records, including many merged, gone, and unrelated unmerged entries from earlier work. There was no option to list only branches created or touched in the current session, or only currently actionable records.

## Impact

Routine end-of-task cleanup verification produces a large, noisy result and makes it harder to confirm that this session's writable branches and read-only snapshots were dropped. Unrelated unmerged branches are especially easy to mistake for current leftovers.

## Evidence

After all dashboard delegates from this session had been merged and dropped, the list still returned more than thirty records spanning prior projects and sessions, with statuses including snapshot, merged, unmerged, and gone.

## Smallest improvement

Add a session-scoped or actionable-only filter to `delegate_branches list`, while retaining the existing all-history view when explicitly requested.
