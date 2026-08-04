# Dashboard architecture baseline

Status: Phase 0 inventory, recorded 2026-08-04 before the canonical-contract and reducer migration.

## Baseline verification

From the repository root:

- `npm run check`: passed (96 test files, 811 tests).
- `pnpm --filter @pi-dashboard/web test:e2e`: passed (3 Playwright scenarios).

The baseline has no known failing checks.

## Current architecture

```text
Pi extension events
  -> extensions/remote-control
  -> protocol-v1 JSONL over a bounded Unix socket
  -> RuntimeRegistry
  -> DashboardServerImpl state/revision publication
  -> authenticated HTTP snapshots + authenticated browser WebSocket
  -> useDashboard React hook
  -> SessionView reconciliation
```

`DashboardServerImpl` in `apps/dashboard-server/src/http.ts` is the current composition root. It also owns HTTP routing, authentication and CORS, browser WebSockets, Unix-socket lifecycle, workspace/session orchestration, uploads, notifications, push, usage caching, snapshot construction, and event publication.

`RuntimeRegistry` in `apps/dashboard-server/src/runtime-registry.ts` owns the runtime connection state. Its important existing invariants are:

- the first frame must be a valid `runtime.hello` within five seconds;
- protocol frames and socket input buffers are bounded;
- managed launch and stable runtime identity credentials are checked separately;
- runtime sequence numbers reject duplicate and out-of-order bridge events;
- a replacement socket invalidates queued commands and acknowledgements from the old connection;
- commands are bounded, serialized per runtime, and acknowledgement timeouts are finite;
- backpressure cannot leave a command queue blocked indefinitely;
- snapshots and events redact embedded image bytes;
- forgotten runtimes cannot reconnect during the same daemon lifetime;
- the Unix socket is created with owner-only permissions.

These invariants are migration constraints, not behavior to replace during Phase 1.

## Browser routes and operations

The browser uses manual history/pathname routing for:

- `/` — dashboard overview;
- `/sessions/:id` — persisted/live transcript;
- `/workspaces/:id` — workspace detail;
- `/runtimes/:id` — runtime detail and controls;
- `/new` — managed runtime launch.

Current dashboard operations are:

- list runtimes, sessions, workspaces, notifications, and usage;
- refresh workspace discovery;
- launch and stop a managed runtime;
- send prompt, steering, and follow-up input;
- upload and attach images;
- abort an active run;
- select model and thinking level;
- rename a session;
- answer or cancel an `ask-user` interaction;
- mark notifications read or read all;
- subscribe to browser push notifications.

The browser WebSocket authenticates with an initial token message. `serverId` and monotonically increasing `revision` values order snapshots within one daemon process. The client maintains request serials, an authoritative socket generation, a bounded revision-deduplication window, a bounded raw event tail, update coalescing, and stale settled-session-read guards.

## Browser API inventory

`apps/dashboard-server/src/http.ts` currently exposes:

- unauthenticated `GET /api/health`;
- authenticated `GET /api/snapshot`;
- authenticated `GET` and `POST /api/workspaces`;
- authenticated `GET /api/usage`;
- authenticated `GET /api/push/vapid-public-key` and `POST /api/push/subscribe`;
- authenticated `GET /api/sessions/:id` and `POST /api/sessions/:id/name`;
- authenticated `POST /api/runtimes/start`;
- authenticated `POST /api/runtimes/:id/command` and `/stop`;
- authenticated `POST /api/interactions/:id/answer` and `/cancel`;
- authenticated `POST /api/notifications/read-all` and `/api/notifications/:id/read`;
- authenticated browser WebSocket `/ws`.

## Parity matrix

“Shared core” records whether the current behavior already derives from a framework-independent semantic implementation.

| Feature | TUI | Dashboard | Shared core | Missing headless API / current limitation |
| --- | --- | --- | --- | --- |
| Prompt, steer, follow-up | Yes | Yes | Partial | Dashboard calls `sendUserMessage`; transport semantics are dashboard-specific. |
| Abort / shutdown | Yes | Yes | Partial | Available on `ExtensionContext`; command contracts are shared. |
| Model / thinking selection | Yes | Yes | Partial | Available through extension APIs; dashboard still exposes one-off bridge commands. |
| Session rename | Yes | Yes | Partial | Available through `setSessionName`; one-off bridge command. |
| Image attachments | Yes | Yes | No | Upload/image validation policy is split between browser, daemon, and adapter. |
| `ask-user` interaction | Yes | Yes | Partial | Broker is shared locally, but bridge/UI contribution is one-off. |
| Activity grouping | Yes | Yes | Yes | Grouping/title semantics use `activity-model`; renderers remain separate as desired. |
| Runtime launch / stop | N/A / external process | Yes | No | Daemon-specific orchestration. |
| Workspace discovery / tmux | TUI environment | Yes | No | Daemon-specific orchestration. |
| Notifications / push | TUI notices | Yes | No | Dashboard-specific derivation and persistence. |
| Compact | Yes | Compatibility shim | No | `ctx.compact()` exists, but remote control parses `/compact`. |
| New session | Yes | No | No | `newSession()` is command-context-only; socket callbacks currently retain only `ExtensionContext`. |
| Resume / switch session | Yes | No | No | `switchSession()` is command-context-only; no semantic remote action. |
| Fork / clone | Yes | No | No | `fork()` is command-context-only; no semantic remote action. |
| Tree navigation | Yes | No | No | `navigateTree()` is command-context-only; no semantic remote action. |
| Export / import / share / copy | Yes | No | No | Built-in interactive command behavior is not exposed as semantic actions. |
| Reload | Yes | No | No | `reload()` is command-context-only; no semantic remote action. |
| Extension commands | Yes | Rejected | No | `getCommands()` describes commands but remote control cannot invoke extension command handlers headlessly. |
| Built-in commands | Yes | Mostly rejected | No | The adapter deny-list is manual; unlisted interactive commands such as `/debug` can currently fall through as model input. |
| Skills / prompt templates | Yes | Expanded in adapter | No | Remote control reads files and imitates expansion. |
| Command palette / hotkeys | Yes | No | No | No shared action descriptors yet. |
| Session tree / branch inspector | Yes | No | No | Depends on semantic session actions and projections. |

## Duplicated validation and reconciliation

The protocol package currently mixes wire contracts with validation, redaction, title derivation, and workspace selection. The browser independently validates browser snapshots, sessions, runtimes, interactions, workspaces, notifications, and weak dashboard event envelopes in `apps/dashboard-web/src/dashboard-transport.ts`.

Canonical transcript behavior currently lives in the browser:

- recursive searches for `id`, `messageId`, `responseId`, `toolCallId`, `callId`, and timestamps;
- replacement of nested tool objects in opaque provider payloads;
- ID-less active-message fallback by role;
- streaming update coalescing;
- settled-file-read generation guards;
- persisted tool-result pairing and transcript key derivation.

The remote-control adapter sends raw Pi event wrappers, so the browser must infer identity after transport. Live Pi events provide a session ID, stable message timestamp, optional assistant response ID, and explicit tool-call IDs. Persisted Pi session entries additionally provide entry IDs, but those IDs are assigned only after message persistence and cannot identify an in-flight event. Phase 1 therefore needs explicit live identity fields normalized in the adapter, with timestamp/response correlation and a runtime-epoch plus sequence fallback. Persisted/live convergence must use a canonical origin key rather than assuming a later session-entry ID equals the live ID.

## Phase 1 invariant

Phase 1 introduces schema-first shared contracts and pure reducers while preserving the current HTTP and WebSocket transports:

> Given the same authoritative snapshot and ordered normalized event sequence, replay produces the same semantic runtime and transcript projection, regardless of whether delivery was live or repeated after reconnect.

The migration must keep historical transcript entries permissive: provider and extension payloads remain opaque data, while their surrounding semantic envelope and explicit identity fields are validated.

## Phase 2: cursor and SSE synchronization

Implemented 2026-08-04. `DashboardEventStream` is the daemon-global clock and bounded in-memory replay log. Every browser publication, including authoritative snapshot replacements, allocates exactly one cursor before subscribers are notified. `BrowserSnapshot.cursor` and the legacy-shaped session response `cursor` identify the authoritative position of each read; `revision` and `serverId` remain only for bounded WebSocket compatibility.

`GET /api/events` is authenticated and origin-checked like the other API routes. It accepts `Last-Event-ID` or the explicit `cursor` query parameter, emits SSE `id` values and canonical event envelopes, sends heartbeat comments, closes clients whose output buffer exceeds its configured bound, and returns HTTP 409 `{ code: "replay-gap" }` when the requested cursor predates the retained window or is ahead of the new daemon generation. Runtime event envelopes retain runtime epoch and sequence fields; envelopes that change dashboard state carry the corresponding projection snapshot. One response remains long-lived: the browser parses and dispatches every CRLF/LF-delimited data frame, with a finite unterminated-frame limit, and reconnects only after EOF, error, abort, or replay-gap resynchronization.

The browser uses a fetch-based SSE adapter so the token remains a header rather than a URL credential. It reconnects with the last accepted cursor, rejects duplicate/older records, retains only a bounded reducer-input window, and refetches `/api/snapshot` after a replay gap. Cursor ordering is scoped by `serverId`: a replacement daemon resets the accepted cursor and buffered events before installing its lower authoritative snapshot. Session hydration installs the HTTP projection at its cursor and applies only newer buffered envelopes through the shared transcript reducer. The old WebSocket remains a bounded, authenticated compatibility path for already-running v1 clients; it can be removed after the production extension/runtime population has migrated to SSE-capable browser clients and the compatibility window has elapsed.

Phase 2 preserves the Unix-socket frame, queue, generation, authentication/origin, upload validation, and image-redaction invariants recorded above. No bearer token is accepted in an SSE URL.

## Phase 3: modular daemon composition

Implemented 2026-08-04. `apps/dashboard-server/src/create-daemon.ts` is the manual composition root: it resolves environment/options into configuration, constructs the SQLite facade, session index, adapters, registry/manager, application services, event stream, and relay callbacks, then injects one explicit `DashboardDependencies` graph into `DashboardServerImpl`. The registry and application relays are connected only after the transport exists, so registry callbacks do not recursively publish themselves. `main.ts` remains the development wrapper; `dist/index.js` is the production/launchd entrypoint. `createDashboardServer` delegates to this same root. Browser HTTP is served by Fastify route plugins in `routes.ts`. The plugin owns request parsing, CORS/auth adaptation, TypeBox-backed boundary schemas, status mapping, and route registration; application methods receive plain values rather than Fastify request/reply objects. `GET /api/events` still hands the raw response to the bounded SSE writer, and `/ws` still uses the raw Node upgrade listener by design.

### Module map

```text
main.ts / create-daemon.ts             manual composition + lifecycle
  -> http.ts                            Fastify/raw transport shell, WS/SSE compatibility
     -> routes.ts                       Fastify browser route plugin + TypeBox schemas
     -> application/
          runtime-service               launch, stop, command, interaction, rename
          session-service               catalogue/transcript access
          workspace-service             Sesh catalogue and refresh persistence
          notification-service          runtime-derived notifications and push fan-out
          usage-service                 bounded provider cache/coalescing
          upload-service                bounded image validation, files, cleanup
          dashboard-application         framework-independent application boundary
     -> repositories/
          migrations                    numbered idempotent SQLite migrations
          sqlite-metadata-repository    workspace/runtime/session/launch metadata
          sqlite-notification-repository notifications and push subscriptions
```

`MetadataStore` is now a compatibility facade over the two SQLite repositories. It preserves existing collaborators while new code can depend on narrower repository interfaces. Migrations are recorded in `schema_migrations`; the credential-column migration is safe for databases created by the pre-Phase-3 schema and can be rerun without changing results.

### Remaining compatibility layer

`http.ts` intentionally retains the old manual dispatcher and its raw Node SSE implementation as a bounded migration aid for tests and existing internal callers; the live listener is Fastify-backed and registers `routes.ts`. It still owns the HTTP/Fastify instance, Unix bridge listener, raw SSE writer, and bounded browser WebSocket at `/ws`; those are transport lifecycles rather than a second dependency graph. `RuntimeRegistry` remains the independently testable Unix-socket bridge and is not wrapped by Fastify. The remaining debt is this legacy dispatcher plus duplicate raw SSE/WS compatibility paths, which can be retired after callers and browser clients leave the compatibility window. The phase does not introduce TanStack, Tailwind, or any Phase 4/5 UI migration.
