# HFM-20260731: Enforce todo dependencies when starting tasks

- **Status:** approved
- **Approval:** approved 2026-07-31
- **Created:** 2026-07-31
- **Source reports:** [HF-20260730: Todo starts a task whose dependency is unfinished](../inbox/20260730T122243Z-todo-starts-blocked-dependent-task.md)

<!-- Proposal and implementation approval are separate decisions. A proposed ticket does not authorize implementation. -->

## Problem

The `todo` tool accepts `start` for a task whose declared prerequisite is unfinished. The resulting plan says the task is both `doing` and waiting, so `depends_on` describes ordering without enforcing it on the primary start operation.

## Baseline

One direct call started T3 while T1, one of T3's dependencies, remained `doing`; the returned dashboard rendered T3 as `doing` and `(waiting on T1)`.

The implementation reproduces that behavior: `extensions/tasks/mutations.ts` assigns `task.status = 'doing'` for `start` without calling `missingDeps`, while `extensions/tasks/domain.ts` already computes unfinished dependency IDs for readiness and rendering. `mutateBatchUnsafe` applies the same mutation and rolls the complete batch back only when a step returns an error.

## Hypothesis

If `start` rejects a task while `missingDeps` is nonempty and identifies those dependencies, then declared ordering will prevent accidental phase starts because both direct and batched starts pass through the same mutation path.

## Guardrails

- Preserve the existing meaning that only `done` satisfies a dependency; `dropped`, `blocked`, `todo`, and `doing` dependencies remain unfinished.
- Preserve atomic rollback for a batch containing a rejected start.
- Do not automatically complete, drop, unblock, or rewrite dependencies.
- Do not change readiness rendering, dependency-cycle validation, metrics semantics, or unrelated status transitions.
- Keep `update`, `replace`, and imported-state policy outside this report's requested `start` boundary; any broader invariant needs separate evidence and a decision.

## Options considered

1. **Reject blocked starts:** Enforces the declared order with an actionable error and reuses existing dependency state; callers must deliberately change the plan before proceeding.
2. **Warn but start:** Preserves permissive behavior but leaves the contradictory state and does not prevent accidental ordering violations.
3. **Automatically mark the task blocked:** Avoids `doing`, but silently changes caller intent and conflates explicit blocking with dependency waiting.

## Recommendation

Implement option 1. Before applying `start`, compute unfinished dependencies and return an unchanged error naming their task IDs. Let existing batch rollback semantics make a blocked start fail the whole batch safely.

## Scope

- **In:** Direct `start`; `start` operations inside `batch`; actionable blocking IDs; focused mutation and tool tests.
- **Out:** Automatic dependency changes; automatic status changes; broader enforcement on `update`, `replace`, or persisted legacy plans; metrics redesign.

## Acceptance criteria

- [ ] Starting a task with one or more dependencies not in `done` returns an error naming every blocking task ID and leaves the plan unchanged.
- [ ] Starting the same task succeeds after every dependency is `done`.
- [ ] A rejected `start` inside `batch` rolls back all earlier operations in that batch and persists no partial state.
- [ ] A dropped dependency still blocks start, matching current readiness semantics.
- [ ] Tasks without dependencies and existing dependency validation continue to behave unchanged.

## Validation

Add focused tests in `extensions/tasks/tasks.test.ts` for direct start, multiple blocking IDs, done success, dropped dependency, and atomic batch rollback. Run the focused tasks tests, then `npm run check`.

## Evaluation

- **Window:** After approved implementation, the first 20 dependency-bearing start attempts or 2026-08-31, whichever is later
- **Result:** pending (`keep` | `revise` | `revert` | `insufficient evidence`)

Compare with the baseline contradictory start. Keep only if no blocked start enters `doing`, every rejection names the blockers, and no valid start requires manual recovery. Record `insufficient evidence` if no dependency-bearing starts occur.

## Implementation and resolution

- **Approved implementation:** Reject direct and batched `start` operations when any declared dependency is not `done`; name every blocker, preserve atomic batch rollback, and leave broader status-transition enforcement out of scope. Approved 2026-07-31.
- **Merged change:** —
- **Resolution:** pending evaluation
