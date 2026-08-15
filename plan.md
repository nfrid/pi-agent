# Pi Dashboard Client–Server Communications Rebuild Plan

## Status

This plan is intentionally phase-bounded. Execute **one phase per agent run**, stop at its exit gate, record the resulting commit hash, and wait for an explicit instruction before starting the next phase.

The rollback mechanism is Git. Do not add runtime feature flags, legacy fallbacks, shadow stores, or dual UI paths solely to make rollback possible.

---

## 1. Objective

Replace the current browser-facing communication stack with a simpler and sturdier model:

- tRPC for typed finite queries and mutations;
- domain-specific SSE subscriptions through tRPC for live data, if the Phase 0 feasibility gate passes;
- one lightweight shell subscription for global summaries;
- one session subscription per currently acquired session view;
- authoritative snapshots, resumable cursors, bounded replay, and explicit synchronization state;
- the existing dashboard UI and component tree, fed by new data-layer adapters rather than rewritten;
- no redesign of the Pi extension/runtime bridge unless a narrowly scoped change is proven necessary.

The core rebuild is complete after Phase 6. Phase 7 is an optional persistent-cache follow-up.

---

## 2. Fixed architectural decisions

### Browser-facing transport

Use a vanilla tRPC client:

- HTTP batching for queries and mutations;
- SSE subscriptions for live updates;
- no Effect;
- no WebSocket transport in the core rebuild;
- no TanStack Query or tRPC React migration during this work;
- existing multipart/upload endpoints may remain plain HTTP where tRPC adds no value.

tRPC is a transport and contract layer here. It does not replace domain snapshots, replay policy, ordering, bounded queues, or client projections.

### Live domains

Start with two live domains:

1. **Shell**
   - workspaces;
   - runtime and session summaries;
   - project, checkout, thread, and run summaries;
   - unread/waiting/interaction state;
   - titles, lifecycle state, and latest lightweight activity metadata;
   - no full token-by-token transcript traffic for background sessions.

2. **Session**
   - transcript messages;
   - tool activity;
   - delegate transcript/live-detail events;
   - session-specific interaction detail;
   - one subscription per acquired session ID.

Do not introduce a generic global event stream under a different name.

### Session switching and missed events

The browser keeps a bounded in-memory cache of recently used session projections.

When leaving a session:

- release its live subscription when no mounted consumer still needs it;
- retain its projection and last accepted opaque cursor in memory.

When returning:

- render the cached projection immediately with status `cached`;
- resume the session subscription from its cursor;
- apply replayed events when the cursor is still recoverable;
- replace the projection with a fresh authoritative snapshot when the cursor is stale, unknown, from another daemon generation, or otherwise invalid;
- mark the projection `live` only after catch-up completes.

The shell stream continues to carry lightweight status changes for every session, so a background session can become waiting, settled, or failed without streaming its entire transcript.

Do not reload a blank session on every switch unless the cached entry was evicted or invalid.

### Cache policy

Core phases use memory only. Persistent browser storage is deferred to Phase 7.

Do not build IndexedDB, cache migrations, an offline command outbox, or multi-environment persistence before the live system has passed hardening.

### Compatibility

- Existing stored Pi sessions must remain readable.
- The extension/runtime socket protocol remains out of scope by default.
- Old browser protocol versions do not need compatibility support.
- A stale PWA client must fail clearly and request a reload/update.
- Old browser-facing SSE and WebSocket implementations must be deleted after cutover.
- Rollback is through commit hashes, never through a production “legacy mode.”

---

## 3. Target shape

```text
apps/dashboard-web
├── existing routes and UI components
├── existing transcript renderers
├── dashboard connection runtime
├── shell projection store
├── session projection registry + in-memory LRU
└── vanilla tRPC client
        │
        ├── HTTP queries/mutations
        ├── shell SSE subscription
        └── session SSE subscription(s)
                │
apps/dashboard-server
├── tRPC router + existing authentication
├── shell snapshot builder + bounded replay feed
├── session snapshot builder + per-session bounded replay feeds
├── existing application/orchestration/session services
└── existing Pi runtime registry
        │
        └── extension/runtime Unix socket bridge — unchanged unless proven necessary
```

One `/trpc` endpoint may serve all procedures. “Domain-specific transport” means separate logical subscriptions and separate SSE requests, not necessarily separate Fastify route prefixes.

### Required stream invariants

Every live domain must provide these semantics, regardless of the exact wire type names:

- an opaque cursor containing enough generation information to reject stale cursors after daemon restart;
- a complete authoritative snapshot at a known cursor;
- ordered events after that cursor;
- a clear catch-up-complete signal;
- duplicate and old-event rejection on the client;
- bounded replay by both event count and bytes;
- bounded per-subscriber queues;
- fresh-snapshot fallback when replay is unavailable or more expensive than rebasing;
- no snapshot/live race;
- cleanup when a subscription aborts.

Do not expose a bare process-local integer as the durable client cursor.

---

## 4. Execution guardrails

These rules override local convenience.

### One phase per run

The agent must execute only the requested phase. It must not continue into the next phase because the current phase “went well.”

At phase completion, report:

```text
Base commit:
Final commit:
User-visible path exercised:
Automated tests run:
Manual demonstration performed:
Old code removed:
Known limitations:
Decision: pass / stop
```

### Git checkpoints

- Start each phase from a clean tree.
- Record the base commit before editing.
- Use coherent commits; internal checkpoint commits are allowed inside the main cutover phase.
- Record the final commit hash only after the phase exit gate passes.
- Do not add runtime fallback code for rollback.
- If a phase fails, return to its base commit or create a corrective branch. Do not keep layering fixes onto an unproven direction.

### No frontend rewrite

The existing dashboard UI is authoritative.

Allowed frontend changes:

- data clients;
- connection lifecycle code;
- stores and selectors;
- hooks/adapters used by existing components;
- minimal status and protocol-mismatch UI;
- focused component changes required to consume the new state shape.

Not allowed without a separate plan:

- replacing the route tree;
- rewriting `dashboard-web`;
- introducing a new UI architecture or design system;
- replacing transcript rendering;
- broad CSS/layout work;
- moving unrelated features;
- adding a new general-purpose frontend state library.

If a phase appears to require broad component rewrites, stop and explain the data-boundary problem instead of proceeding.

### No speculative extension bridge redesign

A bridge change is allowed only when all of the following are true:

1. a failing test or captured runtime trace proves required information is unavailable or incorrect;
2. the browser/server redesign cannot solve the problem locally;
3. the change is narrowly scoped;
4. old runtime sessions remain readable;
5. the phase can demonstrate the change end to end.

Otherwise, leave extensions and runtime transport alone.

### No compatibility detours

Do not:

- support both old and new browser protocols;
- create translation layers for old PWA clients;
- preserve `/ws` “just in case”;
- preserve `/api/events` after cutover;
- keep the 128-event bootstrap overlap after authoritative session synchronization exists;
- create a shadow store or production comparison path.

### Bounded review

Each phase gets:

- implementation;
- focused tests;
- one focused self-review against that phase’s invariants;
- one full repository check at the exit gate.

Do not create recursive review/fix/re-review agent loops. If the design fails a core invariant, stop and reconsider from the phase base commit.

---

## 5. Progress ledger

Fill this table as work proceeds.

| Phase | Base commit | Final commit | Status | Notes |
|---|---|---|---|---|
| 0. tRPC/SSE feasibility gate |  |  | not started |  |
| 1. Production tRPC boundary |  |  | not started |  |
| 2. Authoritative domain snapshots |  |  | not started |  |
| 3. Direct live cutover |  |  | not started |  |
| 3.5. Delegate sessions as normal live sessions | `2a0463e` | phase commit (reported at exit) | passed | Explicit child identity; lazy normal-session inspector acquisition; bounded legacy fallback; hidden auxiliary session indexing. |
| 4. Session switching and in-memory cache | `f348799` | phase commit (reported at exit) | passed | Reference-counted inactive LRU; immediate cached rendering; opaque-cursor replay; coherent eviction and retained history windows. |
| 5. Mutation reliability for touched paths | `f8abab2` | phase commit (reported at exit) | passed | Typed tRPC receipts for runtime commands, start/resume, restart/stop, and rename; stable network retries; payload conflicts; multipart uploads unchanged. |
| 6. Lifecycle, performance, and failure hardening |  |  | not started |  |
| 7. Optional persistent cache |  |  | deferred |  |

---

# Phase 0 — Prove tRPC SSE before committing to it

## Goal

Prove that current tRPC can replace the browser-facing HTTP and SSE plumbing in this deployment without changing the authentication model, leaking tokens into URLs, requiring WebSockets, or weakening recovery behavior.

This is a hard feasibility gate, not permission to start the rebuild.

## Scope

Build a minimal isolated Fastify/tRPC path or test harness that exercises:

- one authenticated query;
- two concurrent domain-like SSE subscriptions;
- existing header-based dashboard authentication;
- a TypeBox-backed input/output parser without duplicating schemas in Zod;
- tracked opaque event IDs;
- disconnect and exact resume;
- daemon-generation mismatch followed by a fresh snapshot;
- server ping and client inactivity reconnect;
- abort cleanup;
- bounded subscriber queues;
- a burst of replaceable events;
- a realistically large frame;
- current development cross-origin behavior and production-style same-origin behavior.

Use a vanilla `@trpc/client` setup. Do not add React Query.

The authentication token must remain in a header. Do not put it in `connectionParams`, query parameters, or tracked event IDs. A fetch-backed EventSource implementation may be used, but it must be pinned and tested rather than selected casually.

Use existing `@pi-dashboard/protocol` TypeBox schemas through a small parser adapter based on the current `parseSchema`/`Value.Check` facilities. Do not create duplicate protocol schemas.

## Required proof cases

1. **Two subscriptions**
   - shell-like and session-like subscriptions stay independent;
   - closing one does not disturb the other.

2. **Tracked resume**
   - receive events 1–3;
   - disconnect;
   - publish 4–6;
   - reconnect;
   - receive exactly 4–6 before live event 7.

3. **Generation reset**
   - reconnect with a cursor from a previous server generation;
   - receive a fresh snapshot;
   - subsequent reconnect uses the new generation rather than repeatedly resetting.

4. **Authentication**
   - valid token succeeds;
   - missing and invalid tokens fail;
   - no token appears in request URLs or logs.

5. **Liveness**
   - idle connections remain alive through ping;
   - a deliberately stalled connection is recreated after inactivity;
   - aborting a subscription releases server listeners and queues.

6. **Bounds**
   - a slow or paused subscriber cannot create an unbounded queue;
   - overflow terminates or rebases predictably;
   - large frames remain within an explicit tested limit.

7. **Build integration**
   - Node, Fastify, Vite, TypeScript, and the current package layout build cleanly.

## Demonstration

Provide a deterministic test or script whose output shows:

```text
snapshot S
events S+1 ... S+n
disconnect
events published while disconnected
resume from last tracked cursor
only missed events received
```

## Exit gate

Pass only if every required proof case works without:

- URL token authentication;
- a WebSocket side channel;
- a second custom reconnect loop fighting tRPC;
- unbounded queues;
- duplicated Zod schemas;
- frontend changes.

Pin exact dependency versions in the lockfile.

If the failure is specific to tRPC SSE, stop. Do not autonomously switch to WebSockets or rebuild the existing custom SSE stack. Report whether tRPC remains suitable for finite queries/mutations and what exact SSE requirement failed.

---

# Phase 1 — Introduce the production tRPC boundary

## Goal

Put a small, real portion of the existing dashboard through tRPC without changing live updates or the UI architecture.

## Scope

Add the production tRPC router and vanilla client infrastructure:

- Fastify tRPC registration;
- context using the existing origin and token authorization rules;
- a TypeBox parser adapter shared by touched procedures;
- a typed error formatter retaining stable domain error codes;
- endpoint selection compatible with the current localhost/LAN candidate behavior;
- a protocol information query returning at least:
  - protocol version;
  - server generation;
  - relevant capabilities.

Migrate the existing dashboard bootstrap snapshot request to a tRPC query and update the current client/store adapter to use it.

Do not migrate unrelated routes. Uploads and untouched REST operations remain as they are.

Do not introduce React Query. The existing `DashboardLiveStore`/hooks may call the vanilla tRPC client.

## Protocol mismatch behavior

Add one small existing-shell error state:

- incompatible protocol version blocks normal startup;
- the UI requests a service-worker update/reload;
- there is no compatibility transform;
- the error is distinguishable from authentication and network failure.

## Cleanup

Once the tRPC bootstrap query is used:

- delete the superseded bootstrap REST route and its client method;
- delete duplicate validation code created only for that route;
- keep the existing live SSE route unchanged for now.

## Acceptance criteria

- The existing dashboard renders its current pages and data through the new tRPC bootstrap query.
- No route, layout, transcript renderer, or design component is replaced.
- Authentication, invalid-token behavior, endpoint selection, and CORS behavior match current expectations.
- An intentionally mismatched protocol version produces the reload-required state.
- The removed REST bootstrap route is no longer callable.
- Full repository checks pass.

## Demonstration

Start the normal dashboard, open the current shell and a session, and show that the UI is unchanged while the bootstrap network request goes through tRPC.

## Stop conditions

Stop if production tRPC integration requires:

- changing the auth model;
- rewriting the frontend root;
- converting all REST routes;
- adding React Query;
- supporting old PWA protocol versions.

---

# Phase 2 — Establish authoritative shell and session snapshots

## Goal

Make domain snapshots complete and trustworthy before changing live transport.

This phase must integrate snapshots into the existing frontend. It must not merely create unused abstractions.

## Scope

Define or tighten two snapshot contracts in `@pi-dashboard/protocol`:

### Shell snapshot

Use the existing browser snapshot shape where practical. Do not rename or remodel it for aesthetics.

It must completely represent global lightweight state at its opaque shell cursor, including current runtime/session summary state and unread/waiting state. It must not contain full transcripts.

### Session snapshot

Create a session-specific authoritative projection containing:

- existing paginated transcript projection data;
- active runtime overlay needed to render current in-flight message/tool/delegate state;
- session metadata required by the existing route;
- an opaque session cursor;
- completeness/page metadata already required by history pagination.

Build it from existing session files, session index data, runtime snapshots, and current projection helpers. Do not introduce a new session persistence format.

Add tRPC queries for these snapshots and use them in the existing stores and session hydration path.

Old stored sessions must continue to open through the existing readers/parsers.

## Required invariants

- A snapshot is complete through its own cursor.
- A snapshot never claims a cursor later than the state it contains.
- A stale asynchronous snapshot response cannot overwrite newer live state.
- A session snapshot can replace an incomplete cached projection without losing newer accepted data.
- Historical pagination remains separate from live synchronization.
- Existing transcript item identity and renderer behavior are preserved.

## Tests

Add focused tests for:

- active session during message streaming;
- active tool call;
- delegate live transcript;
- settled session;
- old stored session with no active runtime;
- paginated history;
- snapshot request racing with newer client state;
- daemon generation change;
- malformed snapshot rejection.

Prefer adapting current transcript/hydration fixtures over inventing a second fixture system.

## Acceptance criteria

- Existing shell and session pages use the new snapshot queries.
- Active and historical sessions render the same visible content as before.
- Old session files require no migration.
- No component-tree rewrite occurs.
- The snapshot code is used by production paths, not only tests.
- Full repository checks pass.

## Demonstration

With one agent actively streaming and one old settled session:

1. open the active session;
2. verify its partial assistant/tool state;
3. open the old session;
4. return to the active session;
5. verify no transcript reset or duplicate rows.

## Stop conditions

Stop if correct snapshots appear to require:

- rewriting transcript rendering;
- redesigning session persistence;
- broad extension bridge changes without a failing evidence case;
- maintaining two independent transcript projections.

---

# Phase 3 — Directly replace the global live transport

## Goal

Cut the browser over from the global custom SSE stream and compatibility WebSocket to domain-specific tRPC SSE subscriptions, then delete the old browser live transport in the same phase.

This is the main cutover phase. It may use internal commits, but the phase is not complete until the old transport is gone. There is no production feature flag and no dual UI mode.

## Server work

### Shell feed

Create one shell feed with:

- per-process generation;
- monotonic domain sequence;
- opaque tracked cursor;
- authoritative snapshot fallback;
- bounded replay by count and bytes;
- bounded subscriber queues;
- lightweight semantic events only.

Do not publish every `message.updated` or `tool.updated` event to shell consumers. Shell updates should represent lifecycle and summary changes. Coalesce replaceable summary updates before they consume replay space.

### Session feed registry

Create lazily managed per-session feeds:

- full session-specific live events;
- bounded replay by count and bytes;
- fresh session snapshot fallback;
- retention long enough to resume a recently viewed active session;
- cleanup after settlement/inactivity;
- no dependence on an active browser subscriber for correctness.

A feed may be created when a relevant runtime event arrives, not only when a browser subscribes. If no replay feed exists, the server must still recover through an authoritative snapshot.

### Generic replay primitive

Reuse the proven logic and tests from the current replay implementation where possible, but remove its global mixed-record assumptions.

A small generic replay/feed primitive is acceptable. A new event-sourcing framework is not.

It must close the snapshot/replay/live race and bound each subscriber. Do not rely on an unbounded `EventEmitter` async iterator.

### tRPC subscriptions

Expose shell and session subscriptions through tRPC SSE with tracked opaque cursors.

The server decides between:

- replay from cursor;
- fresh snapshot;
- catch-up completion;
- live events.

A replay gap is a normal rebase condition, not a reason to leave the client permanently reconnecting.

## Client work

Introduce a small connection runtime that owns:

- selected endpoint;
- token access;
- tRPC client lifetime;
- shell subscription lifetime;
- network/application lifecycle signals.

Use separate projection owners:

- shell projection store;
- session projection registry keyed by session ID.

Preserve the current public hooks/selectors where practical so existing components continue to render without restructuring.

Connection state and domain synchronization state must be separate:

```text
connection: offline | connecting | connected | blocked | error
domain: empty | cached | synchronizing | live | error
```

The shell being connected does not imply an open session projection is synchronized.

## Mandatory deletion in this phase

After the new subscriptions pass their gates, remove:

- `/api/events`;
- browser-facing `/ws`;
- `SseWriter`;
- `WsCompatChannel`;
- the global browser `DashboardEventStream`;
- the custom browser SSE parser and reconnect loop that tRPC now replaces;
- compatibility facade exports used only by the old transport;
- global cursor/recent-event plumbing not used by an intentional diagnostics feature;
- the 128-event bootstrap overlap and its reconciliation assumptions;
- dead tests for removed transport behavior.

Do not retain these behind environment variables.

Keep the Unix-domain extension bridge. It is not the browser WebSocket compatibility channel.

## Required tests

### Ordering and recovery

- duplicate event;
- old event;
- single missing event;
- replay within window;
- replay outside window;
- server generation change;
- snapshot followed immediately by live publication;
- publication during snapshot construction;
- aborted subscriber cleanup.

### Isolation

- a busy session does not evict shell replay history;
- session A traffic does not enter session B;
- closing session A subscription does not affect shell or session B;
- shell receives semantic status changes without full transcript deltas.

### Bounds

- replaceable token/tool updates are coalesced where safe;
- replay buffers have byte and count limits;
- subscriber queue overflow is deterministic and recoverable;
- no large full-browser snapshot is attached to routine events.

### Existing UI

- current shell;
- current session route;
- delegate inspector;
- interaction UI;
- notification state;
- session history;
- orchestration summaries.

## Acceptance criteria

- Normal production UI uses only the new shell/session subscriptions.
- Old browser SSE and WebSocket paths are deleted.
- Startup does not intentionally rewind a cursor.
- Shell and session have independent cursors and sync states.
- A daemon restart rebases both domains cleanly.
- Five simultaneous active runtimes remain usable.
- Fast output does not starve lifecycle or interaction updates.
- Existing frontend component architecture remains intact.
- Full repository checks pass.

## Demonstration

Run the real dashboard with at least two active sessions:

1. observe both in shell;
2. open session A while it streams;
3. interrupt the network;
4. restore it and verify exact recovery or snapshot rebase;
5. switch to session B;
6. restart the daemon;
7. verify shell and the open session recover without a hard page reload;
8. inspect the network panel and confirm there is no `/api/events` or `/ws`.

## Stop conditions

Stop and return to the phase base commit if:

- the old browser transport cannot be deleted in this phase;
- the new path requires a dashboard UI rewrite;
- events can be silently dropped across snapshot/live handoff;
- queues are unbounded;
- shell still carries full background transcript traffic;
- tRPC and application code both run competing retry loops.

---

# Phase 3.5 — Open delegates through normal session subscriptions

## Goal

Treat an explicitly opened delegate as a normal dashboard session without changing delegate execution ownership or subscribing to every delegate in the background.

The parent session remains authoritative for aggregate delegate lifecycle and activity rows. Opening one delegate inspector lazily acquires that delegate's child session projection and reuses the same snapshot, `sessionSubscribe`, transcript reducer, recovery, and navigation behavior as any main runtime session.

## Fixed identity model

Keep the existing identities distinct:

- `runId` identifies one delegate invocation;
- `lineageId` groups continuation attempts;
- `sessionId` identifies the canonical Pi child session consumed by dashboard session APIs and subscriptions.

Every new invocation must carry its child `sessionId` from delegate-session preparation into live status and durable history. Multiple continuation attempts may reference the same child session when the underlying Pi session is reused. Do not infer `sessionId` from `runId`, `lineageId`, display name, file path, or array position.

The delegate session ID is routing identity, not browser authentication. Tokens remain restricted to the existing dashboard authentication header.

## Scope

### Delegate and protocol plumbing

- carry `sessionId` through prepared delegate execution, `DelegatedRun`, live delegate status, durable invocation/history summaries, and result materialization;
- define the field once in strict TypeBox contracts and derive exported types from those contracts;
- retain compatibility for historical delegate records that have no `sessionId`;
- never expose delegate JSONL paths or use paths as browser routing input;
- ensure pruning and continuation recovery do not rewrite or ambiguously reassign child-session identity.

### Inspector acquisition

When a user opens a delegate invocation:

1. resolve the selected invocation's `sessionId`;
2. acquire that session through the existing reference-counted session projection API;
3. render the canonical session transcript and live state with the normal session selectors and transcript components;
4. retain the parent delegate metadata, lifecycle, result, and run selector around that transcript;
5. release the child session when the inspector closes or selects another invocation.

Do not open session subscriptions for collapsed delegate rows. At most the explicitly inspected child sessions are acquired, and duplicate consumers of the same child session must share one projection/subscription.

### Navigation and nesting

Add an explicit “Open as session” action that navigates to the ordinary session route for the child `sessionId`.

A child session may itself expose delegate statuses. Nested delegate inspection must use the same lazy acquisition rule rather than introducing a separate nested-delegate transport or recursive eager subscription tree.

### Fallback behavior

The existing bounded parent-session delegate transcript remains the fallback when:

- a legacy invocation has no `sessionId`;
- the child session has been pruned or is temporarily unavailable;
- acquisition fails before an authoritative child snapshot arrives.

Fallback content must be labeled as bounded/incomplete when applicable. It must not compete with or overwrite an acquired child session projection.

## Non-goals

Do not in this phase:

- subscribe to every active delegate session;
- replace parent-session aggregate delegate status rows;
- redesign delegate execution, worktree ownership, continuation semantics, or result handoff;
- create a delegate-specific transcript reducer, cache, or reconnect loop;
- add Phase 4 LRU policy or Phase 7 persistent browser storage;
- make child-session subscriptions a prerequisite for delegate completion delivery.

## Required tests

### Identity

- fresh foreground and background delegates expose the correct child `sessionId`;
- continuation attempts retain the correct session identity and remain distinct by `runId`;
- durable history round-trips `sessionId` without deriving it from lineage;
- legacy history without `sessionId` uses the bounded fallback;
- session IDs never enter dashboard authentication fields or tracked event IDs.

### Subscription lifecycle

- collapsed rows create no child session subscription;
- opening an inspector creates exactly one child `sessionSubscribe`;
- closing the inspector releases it;
- changing the selected invocation releases the old child and acquires the new one;
- two consumers of the same child share one underlying subscription;
- a gap, daemon restart, and network interruption recover through the ordinary session snapshot/replay path.

### Transcript correctness

- a busy child transcript updates with the same ordering and latency behavior as a selected main session;
- message/tool rows are neither duplicated nor lost when switching between bounded fallback and canonical child projection;
- historical pagination composes with new child live events;
- terminal delegate metadata remains visible after the child runtime settles;
- a nested delegate can be opened from its parent child-session surface without eager recursive subscriptions.

## Acceptance criteria

- Parent delegate rows remain lightweight and require no additional subscription per delegate.
- Opening a delegate reuses the normal session projection and `sessionSubscribe`; no delegate-specific live transcript transport exists.
- Every current delegate invocation has an explicit canonical `sessionId`.
- Legacy or unavailable child sessions degrade to the existing bounded inspector without breaking the parent session.
- “Open as session” uses the ordinary session route and transcript UI.
- Nested delegates require no new transport architecture.
- Full repository checks and browser tests pass.

## Demonstration

1. Start two delegates while viewing their parent session and confirm only the parent session subscription is open.
2. Open delegate A and confirm one child session subscription appears and its transcript advances live.
3. Switch the inspector to delegate B and confirm A is released and B is acquired without duplicate rows.
4. Navigate to “Open as session” and verify the ordinary session route renders the same canonical transcript.
5. Open a nested delegate from that child session and confirm only the explicitly opened nested session is additionally acquired.
6. Interrupt the network and restart the daemon, then verify the opened child session recovers through ordinary session replay or snapshot rebase.
7. Open a legacy or pruned delegate and verify the bounded fallback remains usable and explicitly incomplete.

## Stop conditions

Stop and reconsider if:

- child session identity cannot be made explicit without exposing file paths;
- opening one delegate requires subscribing to all delegates;
- canonical child state and bounded parent fallback both mutate the same transcript projection;
- nested delegates require a new transport or recursive eager subscription model;
- the work expands into delegate execution/worktree redesign or Phase 4 cache policy.

---

# Phase 4 — Make session switching and memory caching explicit

## Goal

Make switching among active and historical sessions fast and deterministic without persistent browser storage.

Phase 3 must already support basic session viewing. This phase formalizes acquisition, release, replay, eviction, and pagination behavior.

## Scope

Create a reference-counted session projection registry:

```text
acquire(sessionId) -> projection handle + release()
```

A session remains subscribed while at least one mounted consumer holds it.

After release:

- retain projection, cursor, sync metadata, and loaded history window;
- remove raw transient event history not needed for rendering;
- place the entry in a bounded LRU;
- evict old inactive entries deterministically.

Use a conservative initial limit and make it one tested constant. Do not build a general cache-policy framework.

On reacquire:

1. expose cached projection immediately;
2. mark it `cached` or `synchronizing`;
3. resume from its cursor;
4. apply replay or replace with snapshot;
5. mark `live` after synchronization.

If a session was evicted, load a fresh snapshot. If a feed expired, rebase. Neither case is an error.

History pagination must merge with the live projection without duplicating messages/tools across page boundaries.

## Required tests

- switch away during assistant streaming, then return;
- switch away during tool execution, then return;
- return while replay is available;
- return after replay expiration;
- return after daemon restart;
- multiple mounted consumers for the same session;
- LRU eviction;
- historical pagination plus new live events;
- identical/repeated message content;
- active runtime replaced or session ID changes;
- old settled session.

## Acceptance criteria

- Background sessions send only shell summaries.
- Returning to a recent session does not flash blank content.
- Missed events are replayed or replaced by a fresh snapshot with no duplicates.
- Eviction is bounded and observable in tests.
- Existing session UI and transcript renderers remain unchanged.
- Full repository checks pass.

## Demonstration

Run three sessions, repeatedly switch among them while one streams, allow one cache entry to be evicted, and show:

- cached immediate rendering for retained entries;
- replayed catch-up for a retained active entry;
- clean fresh load for the evicted entry;
- no duplicate transcript rows.

---

# Phase 5 — Harden mutations that interact with live state

## Goal

Make retryable user actions deterministic when the response or connection is lost.

Do not migrate the entire REST API. Migrate only mutations used by the communication paths touched in Phases 1–4 or known to race with live updates.

Likely candidates include:

- sending a prompt/command;
- answering or cancelling an interaction;
- runtime start/restart/stop;
- session rename;
- thread create/retry/cancel/archive;
- checkout actions used by the current dashboard.

## Scope

For each migrated retryable mutation:

- use a client-generated command ID;
- validate input through the existing protocol schema;
- return a stable typed result or receipt;
- recognize duplicate command IDs durably where duplicate execution would be harmful;
- distinguish accepted, already accepted, completed, rejected, and conflict outcomes where relevant;
- resolve the current server/client runtime at execution time rather than capturing stale state.

Reuse current command receipt/idempotency support where it already exists. Do not invent a second receipt model.

Do not add an offline mutation queue.

## Required tests

- server completes a command but client loses the response;
- client retries the same command ID;
- operation executes once;
- same ID with different payload is rejected as conflict;
- live event arrives before mutation response;
- mutation response arrives before live event;
- authentication failure does not retry forever;
- domain validation errors do not tear down healthy subscriptions.

## Acceptance criteria

- Touched mutations are typed end to end.
- Retry behavior cannot duplicate commands.
- Mutation failures do not masquerade as connection failures.
- Untouched REST routes remain outside scope.
- Full repository checks pass.

## Demonstration

Artificially drop one mutation response after server acceptance, retry with the same command ID, and show one resulting operation plus a stable duplicate receipt/result.

---

# Phase 6 — Lifecycle, performance, and failure hardening

## Goal

Validate the complete communication stack under the environments and failures that currently make it feel flaky.

## Connection ownership

Use one application-level lifecycle owner.

tRPC owns per-subscription transport reconnection and tracked IDs. Application code owns:

- when the endpoint/client exists;
- online/offline state;
- foreground/background wakeups;
- when a session subscription is acquired or released;
- explicit replacement of a stale subscription after meaningful suspension;
- presentation of connection and domain synchronization status.

Do not add a second exponential retry loop around `httpSubscriptionLink`.

Authentication/configuration failures should block until input changes. Transient failures retry. Domain subscription failures should affect that domain without unnecessarily destroying a healthy shell connection.

## Liveness

Configure and test:

- server ping;
- client inactivity timeout;
- foreground probe or controlled resubscribe;
- long hidden-page suspension;
- network interface changes;
- daemon restart;
- clean shutdown.

Use current heartbeat behavior as the baseline. The inactivity timeout must be comfortably longer than the ping interval and covered by deterministic tests.

## Performance and bounds

Measure and expose enough diagnostics to answer:

- current shell/session replay size;
- oldest and newest cursor;
- snapshot fallback reason;
- subscriber queue depth/bytes;
- reconnect count;
- dropped/coalesced replaceable updates;
- largest serialized frame.

Diagnostics may be logs or an existing diagnostics surface. Do not build a new dashboard page unless specifically requested.

Ensure:

- shell events are semantic and low-volume;
- streaming deltas are coalesced before consuming excessive replay space;
- full snapshots are not sent routinely;
- a slow client cannot grow server memory without bound;
- replay fallback is based on bytes as well as count;
- no client render loop processes every token when a latest-value update is sufficient.

## Required environment matrix

1. Desktop Chromium on localhost.
2. PWA-like hidden/suspended/resumed lifecycle through browser automation.
3. LAN or remote access with interruption.
4. Dashboard daemon restart.
5. Fast model output with many message/tool updates.
6. Multiple simultaneous active runtimes.

A real Android device is not required in this phase, but the test plan and diagnostics must make later device validation straightforward.

## Failure injection matrix

- disconnect before snapshot;
- disconnect during snapshot;
- disconnect during replay;
- disconnect after synchronization;
- cursor from future generation;
- expired replay;
- malformed event;
- over-limit event;
- slow subscriber;
- auth token removed/changed;
- offline startup;
- foreground after long suspension;
- server shutdown while subscriptions are active.

## Acceptance criteria

- No silent divergence is observed in the matrix.
- Connection and per-domain statuses remain truthful.
- Recovery is bounded and understandable.
- Memory remains bounded under slow-client and burst tests.
- Old browser transports and compatibility code remain absent.
- No full frontend rewrite has occurred.
- Full repository check, distribution smoke test, and dashboard E2E suite pass.

## Demonstration

Produce one concise hardening report containing:

- scenarios executed;
- observed recovery path;
- relevant cursor/snapshot diagnostics;
- any remaining limitations;
- final commit hash.

The report should contain evidence, not a broad architectural review.

---

# Phase 7 — Optional persistent browser cache

## Goal

Add persistence only if the stable core demonstrates a real need for faster cold startup, instant session reopening after browser restart, or offline reading.

This phase is not required to declare the communication rebuild successful.

## Decision gate

Proceed only if at least one is true:

- cold shell load is measurably annoying;
- reopening recent sessions after browser restart is measurably annoying;
- offline read-only access is desired;
- mobile validation shows frequent process eviction.

Otherwise, record “not needed yet” and close the phase without code.

## Scope if approved

Add:

- a stable non-secret daemon installation ID stored in the dashboard state directory;
- an IndexedDB cache keyed by installation ID and protocol/cache schema version;
- the latest shell snapshot;
- a bounded set of recent session projections and cursors;
- explicit `cached`, `synchronizing`, and `live` states;
- discard-on-version-change policy rather than compatibility migrations unless preserving data is genuinely valuable.

Do not persist:

- authentication tokens inside cache payloads;
- unbounded raw event logs;
- large image/tool blobs already available elsewhere;
- mutation outboxes;
- speculative multi-daemon abstractions.

A cached snapshot must never overwrite a newer live projection.

## Required tests

- valid cache hydration;
- corrupted cache;
- cache from another installation;
- protocol/cache version change;
- live data arriving before cache read completes;
- replay available from cached cursor;
- replay expired;
- quota/IndexedDB failure;
- deterministic LRU eviction.

## Acceptance criteria

- Cached state appears immediately and is clearly not claimed as live.
- Synchronization replaces or advances it without regression.
- Cache failures do not break the live dashboard.
- Storage is bounded.
- Full repository checks pass.

---

## 6. Final definition of done

The rebuild is complete when all core phases pass and the repository satisfies the following:

### Transport

- tRPC is the typed boundary for the touched communication paths.
- Shell and session live updates use independent SSE subscriptions.
- No browser-facing `/api/events` remains.
- No browser-facing `/ws` remains.
- No `SseWriter` or `WsCompatChannel` remains.
- No global mixed-purpose browser event stream remains.
- No intentional cursor rewind/overlap bootstrap remains.

### Correctness

- Snapshots are authoritative at their cursors.
- Resume is exact when replay is available.
- Fresh snapshot fallback is normal and deterministic.
- Server restart is handled through generation-aware opaque cursors.
- Per-domain queues and replay are bounded by bytes and count.
- Existing stored sessions still open.
- Retryable touched mutations are idempotent.

### Client architecture

- Existing UI components and routes remain recognizable and intact.
- Transport creation and retry logic do not live in page components.
- Shell and session sync status are independent.
- Recently used sessions can resume from in-memory cached projections.
- Background sessions do not stream full transcripts.

### Scope discipline

- The extension/runtime bridge was not redesigned without concrete evidence.
- No Effect adoption occurred.
- No React Query migration occurred.
- No broad REST rewrite occurred.
- No browser protocol compatibility layer remains.
- Rollback points are Git commit hashes.

---

## 7. Explicitly out of scope

These require separate plans:

- redesigning the Pi extension/runtime socket protocol;
- durable replay across daemon restarts;
- multi-daemon or T3-style environment registry;
- terminal transport over WebSockets;
- offline mutation queues;
- event-sourcing the whole dashboard;
- replacing session storage;
- rewriting the dashboard UI;
- migrating every REST endpoint to tRPC;
- persistent browser cache before Phase 7 approval.

---

## 8. Initial agent instruction

Start with **Phase 0 only**.

Before editing:

1. record the current commit hash;
2. inspect current auth, endpoint selection, Fastify setup, and TypeBox parser utilities;
3. build the smallest feasibility harness that can prove or disprove the Phase 0 gates;
4. do not touch dashboard UI code;
5. stop after the Phase 0 report and final commit hash.