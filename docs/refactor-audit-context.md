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

## Follow-up implementation (September 2026)

The follow-up audit at `8a359e32` was implemented as six isolated batches:

- Usage has one portable, typed normalization contract in dashboard-protocol.
  Codex transport, broker reads, footer, browser views, and history storage use
  that contract. Provider parsing is no longer independently maintained by the
  consumers. Legacy reset timestamps retain the seconds/milliseconds heuristic;
  relative resets are anchored to capture time. Duration-less footer labels and
  presentation-specific multiweek labels remain distinct from dashboard labels.
- Compact workflow evidence projection, bounds, and journal validation share a
  contract owner. Live and durable evidence remain distinct, and coordinators
  still own lifecycle mutation. Wake source expansion and symbolic-branch
  workspace constraints also share their underlying rules without unifying
  caller-specific rejection and diagnostic behavior.
- Dashboard activity entries are derived once through a typed activity-model
  adapter. Raw compatibility adaptation uses the same semantic implementation.
  Unresolved declared/inline tool calls and explicit tool errors retain their
  previous grouping semantics.
- Authoritative history pages reuse their hydrated projection. Cached coverage
  is validated against page facts and reconstructed with the existing coverage
  constructor. Production-generated overlap and origin-placeholder shapes are
  covered by round-trip tests; inconsistent aggregates are rejected.
- Orchestration tracks execution through one promise map instead of a parallel
  set and polling helper. REST/tRPC share domain classification and database
  redaction while retaining transport-specific defaults and REST explicit error
  codes. Runtime and dashboard consumers use narrower repository capabilities;
  SQLite remains the sole transaction owner.
- SessionIndex retains path safety, catalogue publication, metadata persistence,
  and watcher ownership. Its bounded JSONL scanner returns descriptors, physical
  byte proofs, header facts, and file version information without publishing
  catalogue state. Malformed-file removal and concurrent-change behavior remain
  distinct.

The extraction includes explicit correctness changes at two boundaries: cached
coverage rejects inconsistent persisted facts, and REST now uses the richer
nested database-detail redaction policy already present in tRPC. Both transports
recognize `session-link-conflict`. These are not a protocol or storage migration.

### Follow-up validation

- `PATH="$PATH:/usr/sbin:/sbin" bun run check`: typechecks and lint pass;
  2,218 tests pass. Two assertions in `apps/dashboard-server/src/migrations.test.ts`
  fail because they expect migration 19 while the existing migration list includes
  20. Both failures reproduce at the original `8a359e32` revision. Adding the
  system-tool PATH resolves the process-host test's environment-only `lsof` error.
- Workspace production builds pass. Codex usage has a package-local Vitest config
  so its new protocol dependency resolves from package cwd as well as root tests.
- Fourteen filtered Playwright checks cover usage, transcript grouping, pagination,
  retained caches, and reconnect. Nine pass; five failures reproduce in a detached
  `8a359e32` worktree: the older-active transcript button assertion, the reconnect
  fixture's `Live generation` assertion, two history-navigation `Load earlier
  history` assertions, and the desktop usage/settings ambiguous text locator.
- The temporary baseline worktree was removed. Tests used isolated web/API ports;
  no production state, sockets, runtime host, or process host were used.
- This branch has not been merged into the production checkout or deployed.
  Baseline failures remain explicit release caveats, not passing checks.

## September 2026 shutdown and recovery hardening

The audit at `ddc34986` was implemented in the isolated `fix/audit-hardening`
branch. These constraints apply to the follow-up work:

- `clear_done` retains the transitive prerequisite closure of unfinished tasks.
  Dropped prerequisites remain unsatisfied; cleanup never rewrites dependency
  edges or leaves new dangling references.
- Pinned HTTP requests honor Node's DNS lookup contract. The transport owns
  compression decoding and cancellation; extraction bounds decoded content.
- Worktree recovery validates repository, registration, and branch identity
  before activation or delegate observation. Caller-owned checkout cleanup
  policies remain distinct. Cleanup errors report the latest durable record.
- Runtime-host shutdown closes launch admission and drains existing launch
  locks. Session-index shutdown drains scans, rebuilds, watcher setup, and
  admitted renames before metadata teardown. Failed HTTP startup can still
  retry with the same index; final shutdown is terminal.
- Remote-control scope replacement stages snapshots before changing ownership.
  Queue snapshots follow session identity. Fresh-turn markers belong to the
  scoped generation, so old cancellation callbacks cannot consume new markers.
- Portable delegate compatibility identities have one protocol owner; persisted
  hashes and the distinct legacy extension run-ID algorithm are unchanged.
- History pagination uses the explicitly owning client. Finite and feed session
  snapshots must match the requested session ID. Existing retained-history
  reconciliation was verified and deliberately left unchanged.

This work does not introduce a lifecycle framework, change storage formats,
merge into `main`, or deploy/restart production services.

### Hardening validation

- `PATH="$PATH:/usr/sbin:/sbin" bun run check`: all typechecks and lint pass;
  2,382 tests pass and one server file-read boundary test fails resolving `ajv`
  through Bun's global isolated dependency symlinks. This aggregate command is
  not green. Native Node resolves the dependency; no missing dependency was
  added and no shared cache was modified to hide the failure.
- `bun run --filter @pi-dashboard/server test`: all 413 tests pass independently.
  The server Vitest config preserves symlinks, which fixes scoped execution but
  does not eliminate the aggregate runner failure. Its remaining cause is not
  established; changing the general launcher was deliberately left out of scope.
- `bun run workspace:build` passes. Five filtered Playwright checks pass across
  pagination, retained/persisted cached sessions, offline delegate inspection,
  and incompatible browser-shell handling. Tests used isolated ports 45974 and
  45973; no deployment or production service restart occurred.
- The combined change was reviewed, including independent lifecycle review and
  the standalone delegate-inspector client-ownership regression. The main
  checkout remains clean at `ddc34986`; changes remain in the audit worktree.

## Validation baseline

The integrated change is expected to pass `bun run check`, a production dashboard-web build, focused contribution/protocol/delegate/web tests, and the usage Playwright flow. The final commands and counts belong in the implementing change record; do not treat this note as a substitute for rerunning them after later edits.
