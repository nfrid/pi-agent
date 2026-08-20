# Durable thread lifecycle refactor

## Why

The dashboard currently presents two related but different identities: the Pi
session index (`apps/dashboard-server/src/session-index.ts` and
`packages/dashboard-protocol/src/schemas.ts`'s `SessionIndexEntry`) and the
orchestration thread/run records (`packages/dashboard-protocol/src/orchestration-contracts.ts`,
`apps/dashboard-server/src/repositories/migrations.ts`). The browser joins
these through runtime/session projections rather than through one durable
thread identity. That is workable for the current workspace view, but it makes
lifecycle controls and unread state ambiguous.

The durable model should make a **thread** the user-facing unit, with an
append-only lifecycle history and explicit projections:

- `thread` owns identity, title, project/workspace association, and lifecycle;
- `run` records attempts and runtime execution separately;
- lifecycle events record actor, reason, and timestamp for every transition;
- notification/read state is keyed to durable thread/run events, not a browser
  session or runtime connection.

The projection should support **archive**, manual **settle/unsettle**,
**snooze**, and **pin/unpin** as durable, idempotent operations. Archive is a
terminal visibility choice (with an explicit restore policy); settle/unsettle
is a user decision that must not pretend a runtime stopped; snooze stores an
until timestamp and suppresses notifications until then; pin is an ordering
preference. These meanings must remain distinct from runtime states such as
`waiting`, `failed`, and `stopping`.

Unread must be precise: derive it from durable event/read markers (including
per-thread read position or event acknowledgement), not from `snapshot.unread`
being a lossy count or from whether a page happened to be opened. A read
operation should be idempotent and scoped to the thread/event that was seen.

## Workspace and project unification

Introduce a canonical project identity for a repository root and make a
workspace/checkout an execution location under that project. Existing Sesh
workspace discovery remains useful for launch placement, but it should resolve
to the same project/thread association rather than create a second user-facing
container. Preserve external/non-repository workspaces as valid locations.

The current API already has the beginnings of this shape in `ProjectSummary`,
`CheckoutSummary`, `ThreadSummary`, and `RunSummary` in
`packages/dashboard-protocol/src/orchestration-contracts.ts` and the optional
browser fields in `BrowserSnapshot` (`packages/dashboard-protocol/src/schemas.ts`).
Those summaries should eventually point to one canonical thread record instead
of requiring the UI to infer relationships from `workspaceId`, `cwd`, or an
active runtime.

## Compatibility and sequencing

1. Specify the durable state machine, command IDs, event/read semantics, and
   archive/settle/snooze/pin invariants in the protocol contracts. Do not infer
   lifecycle from a socket's presence.
2. Add repository migrations and a dual-write/dual-read compatibility layer in
   `apps/dashboard-server/src/repositories/migrations.ts`, the SQLite metadata
   repository, and the application services. Backfill threads from existing
   session-index and orchestration rows with stable IDs and provenance.
3. Publish a versioned projection that can serve both old `BrowserSnapshot`
   consumers and the new thread/project model. Keep the event cursor and
   command idempotency rules intact; old clients should see conservative
   session/runtime summaries during rollout.
4. Migrate client query/mutation options in
   `packages/dashboard-client/src/query-options.ts` and dashboard views (for
   example `apps/dashboard-web/src/features/agent-thread-nav.tsx`,
   `apps/dashboard-web/src/features/notifications.tsx`, and
   `apps/dashboard-web/src/features/workspace-view.tsx`) to durable thread IDs.
5. Only after read parity, replay, retry, and migration metrics are proven,
   retire inference and old writes. Keep a rollback path until all persisted
   rows have a known mapping.

## Important implementation warning

Do **not** add session-local lifecycle flags such as `isArchived`,
`isSettled`, `isSnoozed`, `isPinned`, or `hasUnread` to React state, runtime
snapshots, or `SessionIndexEntry`. A session/runtime connection is ephemeral
and can reconnect, disappear, or be replaced; such flags would diverge across
browsers and be lost on restart. The durable store and its ordered events must
be authoritative, while browser state is only a cache of that projection.

## Current non-goals

- Do not alter durable lifecycle code, migrations, protocol schemas, or server
  behavior as part of the workspace UX work.
- Do not make Sesh/tmux a durable thread store or add cold-start/terminal
  emulation to the dashboard.
- Do not merge transcript JSONL into the metadata database; Pi session files
  remain the transcript source of truth.
- Do not implement multi-user ACLs, cross-device conflict resolution, or a
  generalized workflow engine in this refactor.
- Do not conflate runtime stop/failure with user settlement, and do not silently
  archive or mark a thread read merely because it was rendered.
