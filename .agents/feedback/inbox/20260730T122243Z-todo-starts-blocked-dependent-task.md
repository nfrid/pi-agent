# HF-20260730: Todo starts a task whose dependency is unfinished

- **Status:** triaged
- **Observed date:** 2026-07-30
- **Source cwd/repo:** `/Users/nfrid/.pi/agent` harness repository
- **Task shape:** Multi-phase ticket review with explicit todo dependencies
- **Harness component:** `todo` task-state tool
- **Route / attempt / outcome:** Parent called `todo start` for a task that depended on an unfinished task; the mutation succeeded and rendered the task as both `doing` and waiting on its dependency
- **Observed cost / rework:** The plan entered a contradictory state, so dependency ordering had to remain enforced manually rather than by the task tool
- **Recurrence / confidence:** Observed once directly; likely whenever `start` or a batch start targets a task with unmet dependencies
- **Ticket:** [HFM-20260731: Enforce todo dependencies when starting tasks](../tickets/20260731-enforce-todo-start-dependencies.md)

## Behavior

The todo tool accepts `start` for a task whose `depends_on` prerequisite is not `done`. The resulting dashboard can show that task as `doing` while also saying it is waiting on the unfinished prerequisite.

## Impact

Dependencies do not reliably enforce execution order. An agent can accidentally begin a later phase before its prerequisite is complete, and downstream todo metrics may treat the contradictory state as active progress rather than a blocked plan.

## Evidence

In this session, T3 depended on T1 and T2. T2 was done while T1 remained `doing`. A `start T3` mutation succeeded; the returned state showed T3 as `doing` with `deps=[T1,T2]` and `(waiting on T1)`. No error or override warning was returned.

## Smallest improvement

Reject `start`—including a start inside `batch`—when any dependency is unfinished, and return the blocking task IDs so the caller can complete, drop, or explicitly revise the dependency first.
