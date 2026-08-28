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

The bounded audit implementation completed these items:

- Feed cursors distinguish checkpoint, snapshot, event, and caught-up frames while accepting legacy cursors without a frame field.
- Oversized web results remain available for in-process continuation when cache-file persistence is refused.
- Usage tests preserve the intentional history relevance gate.
- Dashboard renderer contracts, surface adapters, settlement keys, and session history controls moved to leaf modules. Production dashboard-web now has no strongly connected import components.
- Browser code no longer imports contribution contracts from extension implementation directories. `@pi-dashboard/extension-contributions` owns built-in renderer IDs, view-model schemas and types, descriptors, and bounded delegate usage. Extension contribution modules retain compatibility re-exports, and the renderer registry remains static and schema-validated.
- Shared scoped services depend on a narrow workflow scheduling capability rather than the concrete delegate workflow coordinator.
- `@pi-dashboard/activity-model` owns tool-sequence renderer types; the extension module is a compatibility re-export.
- Delegate-history and workflow protocol schemas moved into focused internal modules while public protocol exports remain stable.
- Server project association uses a narrow repository capability. Session-history cursor parsing, validation, and bounded reads moved into a focused collaborator behind the existing facade.
- Delegate workflow launch and wake restore policy moved into pure modules. Their input contracts are leaf-owned so the extraction does not introduce coordinator-policy cycles; coordinators retain lifecycle, persistence, dispatch, and mutation ownership.
- Repository-dead dashboard-domain transcript aliases were removed after consumer inventory.

The final cycle inventory still contains three pre-existing extension-internal components: the delegate execution/type component, the delegate plan/orchestration/tool component, and the task store/domain pair. They were not coupled to the corrected dashboard or contribution boundaries and should be handled only as separate behavior-preserving work.

## Validation baseline

The integrated change is expected to pass `bun run check`, a production dashboard-web build, focused contribution/protocol/delegate/web tests, and the usage Playwright flow. The final commands and counts belong in the implementing change record; do not treat this note as a substitute for rerunning them after later edits.
