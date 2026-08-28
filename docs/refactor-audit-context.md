# Refactor audit context

## Purpose

This note records the August 2026 architecture audit and the agreed implementation order. It exists so later refactors preserve the behavioral and compatibility constraints discovered during the audit instead of reopening them from file size alone.

## Immediate correctness work

1. Live-feed tracked IDs must identify every emitted transport frame, not only a semantic sequence. `BoundedFeed.subscribe()` can emit an event and the following `caught-up` marker with the same encoded ID. The client deduplicates by tracked ID, so it can discard `caught-up` and leave a session synchronizing forever. Fix the cursor contract and cover the real tRPC subscription path.
2. Oversized web results must not advertise `get_search_content` continuation unless the result is present in the in-memory result store. File persistence may remain capped. The already-materialized result can stay available for the current extension process even when no cache file is written.
3. Usage quick-history intentionally returns no limit rows while history is absent, loading, or unavailable. Historical activity is currently the relevance filter and prevents unrelated provider limits such as Spark from appearing. Do not change this to show all current limits. If history-independent display becomes necessary, add an explicit include or exclude filter based on stable limit IDs. Do not infer relevance from names or percentages.

## First architecture cuts

- Break dashboard-web import cycles by moving renderer registry types into a leaf module and replacing internal barrel imports with leaf imports. Preserve the static renderer registry and schema validation.
- Stop browser code from importing mutable extension runtime types. Renderer IDs, TypeBox view-model schemas, and schema-derived types belong in a portable contribution contract module. Extension stores and coordinators remain under `extensions/`.
- Replace the shared runtime layer's concrete `DelegateWorkflowCoordinator` dependency with the smallest structural interface required by shared consumers.
- Canonicalize activity renderer types in `@pi-dashboard/activity-model`; extension-local compatibility modules may re-export them temporarily.

## Later structural work

These changes need focused phases and should not be bundled with correctness fixes:

- Split `OrchestrationRepository` into capability-sized interfaces while retaining one SQLite transaction owner initially.
- Keep `SessionIndex` as a facade and extract JSONL indexing, cursor validation, bounded page reads, and watcher scheduling as pure or narrowly stateful collaborators.
- Split `packages/dashboard-protocol/src/schemas.ts` internally by protocol domain while preserving public exports.
- Extract pure restore, binding, transition, and snapshot functions from delegate workflow and wake coordinators. Keep their lifecycle-owning classes.
- Inventory compatibility aliases against named consumers before deleting them.
- Split large test files by behavior when their production subsystem is touched.

## Non-goals

- No Redux, Zustand, XState, ORM, dependency-injection container, or dynamic plugin loader.
- No broad rewrite of synchronization, session indexing, worktree management, or delegate recovery.
- No abstraction merely because two small helpers share a name.
- No removal of SSRF wrappers, bounded payload checks, explicit SQL, or static renderer registration.
- No dashboard deployment from a mixed checkout. Follow `docs/dashboard-deployment.md` after scoped validation and an isolated build if unrelated work appears.

## Implementation status

The first implementation pass completed these items:

- Feed cursors now distinguish checkpoint, snapshot, event, and caught-up frames while accepting legacy cursors without a frame field.
- Oversized web results remain available for in-process continuation when cache-file persistence is refused.
- The usage test now matches the intentional history relevance gate.
- Dashboard renderer contracts and session history controls moved to leaf modules. The largest frontend import cycle fell from 18 modules to 9; the remaining registry, delegate surface, and inspector cycle still needs a separate composition change.
- Shared scoped services no longer import the concrete delegate workflow coordinator.
- `@pi-dashboard/activity-model` now owns the tool-sequence renderer types; the extension module is a compatibility re-export.

The repository, session-index, protocol-schema, contribution-contract, remaining frontend-cycle, and delegate-coordinator work remains for later focused phases.

## Validation baseline

At audit time, repository typechecking, protocol tests, activity-model tests, dashboard-client tests, and focused extension tests passed. `apps/dashboard-web/src/features/usage-indicator.test.tsx` had one stale expectation that contradicted the intentional history relevance filter.
