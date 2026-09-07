# Remote Pi dashboard

The dashboard is a self-hosted web interface for local Pi runtimes. Managed Pi
runtimes are headless `pi --mode rpc` children owned by the stable runtime-host
sidecar; the dashboard consumes bridge events and persisted session JSONL. It
does not scrape terminal output, expose a shell endpoint, or copy transcripts
into its metadata database.

## Packages and applications

- `extensions/remote-control` adapts Pi runtime events, commands, capabilities,
  models, and thinking levels to the bounded Unix-socket protocol.
- `packages/dashboard-protocol` owns the versioned wire schemas, parsers, limits,
  validation, and redaction rules.
- `packages/dashboard-domain` owns framework-independent runtime and transcript
  projections.
- `packages/dashboard-client` owns authenticated HTTP, resumable SSE, token
  storage, query/mutation factories, and the browser live store.
- `packages/extension-contributions` defines schema-first extension actions,
  renderers, and inspectors. See
  [extension-contributions.md](extension-contributions.md).
- `packages/activity-model` is the shared activity grouping/title model used by
  the Pi TUI and dashboard.
- `packages/codex-usage` provides the isolated usage adapter.
- `apps/dashboard-server` is the localhost HTTP/SSE/WebSocket daemon, Unix bridge
  listener, runtime manager, session index, and SQLite metadata store.
- `apps/dashboard-web` is the mobile-oriented React/Vite PWA.

## Local setup

Node **25 or newer** is required because dashboard metadata uses the maintained
built-in `node:sqlite` API. Session transcripts remain Pi JSONL files.

From the repository root:

```sh
bun install
cp .env.dashboard.example .env.dashboard
# Replace PI_DASHBOARD_AUTH_TOKEN and adjust origins if needed.
bun run dashboard:dev
```

`bun run dashboard:daemon` and `bun run dashboard:web` run either side separately.
Root environment variables override `.env.dashboard`; the private environment
file is gitignored. When the daemon and web app use different origins, set
`VITE_DASHBOARD_URL` for the web build and allow that exact origin through
`PI_DASHBOARD_ORIGINS`.

A manually started Pi process registers when the extension is loaded and the
bridge socket is configured:

```sh
PI_DASHBOARD_SOCKET="$HOME/.pi/agent/dashboard/bridge.sock" pi
```

Dashboard launches use a fixed headless RPC `pi` argv, a persisted project and
checkout with an absolute validated cwd, and one child per managed runtime.
Manually started runtimes are associated to registered projects by cwd; unmatched
runtimes remain explicitly unassigned.

For production build and restart instructions, see
[dashboard-deployment.md](dashboard-deployment.md). For isolated profiling,
benchmarks and measured tradeoffs, see
[dashboard-performance.md](dashboard-performance.md).

## Configuration

| Variable | Purpose |
| --- | --- |
| `PI_DASHBOARD_HOST` / `PI_DASHBOARD_PORT` | Daemon bind address and port; defaults to `127.0.0.1` and an ephemeral port. |
| `PI_DASHBOARD_WEB_PORT` | Local web preview port used by the development/serve script. |
| `PI_DASHBOARD_SOCKET` | User-private Unix bridge socket. |
| `PI_DASHBOARD_AUTH_TOKEN` | Stable browser token; otherwise a token is generated and stored under the state directory. |
| `PI_DASHBOARD_ORIGINS` | Comma-separated exact browser origins. |
| `PI_DASHBOARD_STATE_DIR` | Metadata, token, upload, and socket directory. |
| `PI_SESSION_DIR` | Optional Pi session-root override. |
| `PI_DASHBOARD_VAPID_PUBLIC_KEY`, `PI_DASHBOARD_VAPID_PRIVATE_KEY`, `PI_DASHBOARD_VAPID_SUBJECT` | Optional Web Push configuration. |
| `PI_DASHBOARD_NOTIFY_SETTLED=1` | Opt in to settled-run notifications. |
| `PI_DASHBOARD_RUNTIME_HOST_SOCKET` | Owner-private Unix socket for the stable headless runtime-host sidecar. |
| `PI_PROCESS_HOST_SOCKET` | Separate owner-private Unix socket for durable shell jobs; defaults to `background-jobs.sock` under the state directory. |
| `PI_EXECUTABLE` | Optional Pi executable override for the runtime host; the launchd template pins `/opt/homebrew/bin/pi`. |

## File viewer

Markdown file links open a read-only surface without leaving the conversation:
`[method](src/file.ts:123)`, `src/file.ts:123-145`, and
`src/file.ts#L123-L145` target source lines. Absolute paths and `~/` paths refer
to the dashboard host and its user, not the browser device. Relative transcript
links use the originating session's cwd (including delegate checkouts); links
inside a Markdown preview use the viewed file's directory.

The viewer has independent Back/Forward history, scroll restoration, Refresh,
and Copy path. Markdown defaults to Preview, except line-targeted links open
Source. Preview heading links participate in viewer history. Raw HTML is not
executed and preview images are disabled to avoid implicit network/file loads.

**Access boundary:** authenticated dashboard users can explicitly read any
regular UTF-8 text file accessible to the daemon account, including files outside
registered projects. This is intentionally not a checkout sandbox. Reads are
bounded to 1 MiB and reject binary files and special files. No file contents are
prefetched from transcript links or persisted in browser storage. The viewer
shows the current file on disk, not a historical message-time snapshot.

Source rendering uses `@pierre/diffs`' virtualized `CodeView`. File destinations
and viewer history are separate from rendering, leaving room for a future file
list/tree and stacked diffs. Diff comparisons, revision identities, agent-change
attribution, symbol navigation, and editing are not implemented yet.

## Architecture

```text
Pi extension events
  -> extensions/remote-control
  -> bounded JSONL over a user-private Unix socket
  -> RuntimeRegistry and DashboardApplication
  -> independent shell/session feeds + runtime/transcript projections
  -> authenticated protocol-v3 tRPC snapshots and resumable SSE
  -> DashboardLiveStore
  -> TanStack Router/Query React UI
```

`apps/dashboard-server/src/create-daemon.ts` is the single manual composition
root. It resolves configuration and constructs repositories, adapters, the
runtime registry and manager, application services, the event stream, and the
transport dependency graph. `main.ts` is the development wrapper;
`dist/index.js` is the production entrypoint. Browser routes are registered by
the Fastify plugin in `routes.ts`; `http.ts` owns the Fastify server plus the raw
Unix listener, bounded SSE writer, and WebSocket upgrade lifecycle.

The application layer is split by responsibility:

```text
application/
  runtime-service       launch, restart, stop, commands, rename
  session-service       session catalogue and transcript access
  notification-service  runtime-derived notifications and push fan-out
  usage-service         bounded provider cache and request coalescing
  upload-service        bounded image validation, ownership, and cleanup
repositories/
  migrations                     numbered idempotent SQLite migrations
  sqlite-metadata-repository     runtime/session/launch metadata
  sqlite-notification-repository notifications and push subscriptions
```

`MetadataStore` remains a narrow compatibility facade over the SQLite
repositories. The browser WebSocket and `revision` fields remain bounded
compatibility surfaces; the web client uses authenticated SSE cursors as its
primary synchronization mechanism.

### Synchronization model

`ShellFeed` and per-session `SessionFeed` instances use `BoundedFeed` for replay,
queue limits, and tracked cursors. Each domain has its own semantic sequence.
Tracked IDs also distinguish snapshot, event, and caught-up frames; they are not
interchangeable with semantic sequence numbers. Replay gaps receive an
authoritative subscription snapshot rather than triggering finite HTTP polling.
The shell establishes daemon-generation authority before sessions rebase.

`DashboardConnectionRuntime` owns subscriptions, reference counts, callback
invalidation, opaque resume IDs, and browser online/visibility handling. tRPC owns
transport retry. `DashboardLiveStore` alone owns accepted semantic sequences and
normalized projections; `domain-sync.ts` defines its pure acceptance rules.
`react-store.ts` is the React binding, separate from the core store. Entity-array
selectors cache by the relevant normalized index, not by unrelated usage updates
or another store's last read.

`session-transcript-state.ts` owns history coverage and persisted/live
reconciliation. Persisted/live convergence uses explicit runtime, session,
message, and tool identities rather than recursively inferring IDs from provider
payloads. A durable tool declaration does not prove that a newer live result was
persisted.

### Ownership rules for changes

- Snapshot/projection reads do not advance the session metadata publication
  baseline. Only initialization and delta publication own that baseline.
- `SessionIndex` keeps its current catalogue readable while staging a rebuild.
  One synchronous publication replaces it; live scans use catalogue epochs and
  per-file revisions so unrelated scans do not discard each other's updates.
  Staging does not write session metadata.
- The application retains at most 256 uncertain inactive transcript overlays;
  active sessions are not evicted by this limit. Exact IDs of evicted uncertain
  overlays are bounded separately at 256. If that evidence overflows, snapshot
  completeness remains conservatively false for the daemon lifetime rather than
  silently claiming lost observations were persisted. This is process-local
  evidence, not a durable transcript archive.
- The daemon in `http.ts` owns teardown. It closes mutation admission and live
  feeds before awaiting HTTP drain, then attempts every collaborator cleanup and
  aggregates errors. Normal disposal, including failure after HTTP has listened,
  is terminal; create a new daemon rather than reusing closed resources.
- Navigation derives rows from indexed run/link/thread joins and depends only on
  the entity arrays it reads. It must not own mutation or submission completion.
- `DraftPromotionLifecycle` reconciles accepted drafts against authoritative
  session chronology. The composer draft owner acquires leases on subscription,
  not render, and pairs text with a random revision in one atomic local-storage
  envelope. Acknowledgements clear only that revision, including after navigation;
  the controlled editor reflects the same state. Clean unobserved records are
  released; pending submissions and failed-write dirty data are retained. Legacy
  plain-text drafts are read and migrated on their next write.

When adding a feature, extend its existing owner rather than adding a second
cache, retry loop, or lifecycle authority. Keep failure/reconnect tests with the
boundary whose invariant they protect.

### Runtime bridge invariants

`RuntimeRegistry` enforces these boundaries:

- the first frame is a valid `runtime.hello` within a finite timeout;
- frames, socket buffers, commands, and acknowledgements are bounded;
- one-time launch credentials and persistent runtime identity credentials are
  checked separately;
- runtime sequence numbers reject duplicate and out-of-order events;
- replacing a socket invalidates commands and acknowledgements from the old
  connection;
- commands are serialized per runtime and cannot block indefinitely;
- snapshots and events redact embedded image bytes;
- forgotten runtimes cannot reconnect during the same daemon lifetime;
- the Unix socket and persisted credentials are owner-only.

Opaque runtime locations and hashed credentials persist in SQLite so reconnects
survive dashboard socket churn and daemon restart. The runtime host owns managed
Pi child process groups, drains RPC pipes, and force-closes them on shutdown or
crash; children are never adopted. The dashboard never becomes a second agent
protocol.

### Durable background jobs (phase 1)

`@pi-agent/background-jobs` defines a bounded, versioned JSONL protocol over the
separate `PI_PROCESS_HOST_SOCKET`. The separate process-host sidecar (`process-host-main.ts`) owns Bash jobs
and stores their identity, launch facts, status, exit details, and bounded
stdout/stderr tails in `background-jobs.sqlite`. Job IDs are UUIDs: retrying the
same ID and launch facts is idempotent, while different facts conflict.

Jobs survive parent Pi session shutdown and recreation. Completion is
acknowledged only after its keyed message enters Pi context; queued messages
remain retryable across shutdown. The extension manager therefore detaches on
disposal; users must explicitly run `background stop` to terminate a job. A host restart marks persisted active rows failed with an
explicit host-restart diagnostic and never adopts a PID by itself. Settled jobs
are retained per owner session with active jobs plus at most 32 settled rows.
Delegate execution is not migrated in phase 1; delegate migration remains
pending.

## Browser surface

The TanStack Router tree exposes:

- `/` — thread browser and empty workspace;
- `/sessions/:id` — persisted and live transcript;
- `/projects` and `/projects/:id` — registered project catalogue and details;
- `/projects/:id/new` — project-scoped thread launch;
- `/drafts/:id` — local draft thread;
- `/runtimes/:id` — runtime details and controls;
- `/new` — compatibility redirect into project-scoped launch.

The UI supports launch/restart/stop, prompt/steer/follow-up input, image
attachments, abort, model and thinking selection, and session rename.
answer/cancel, workspace refresh, notifications, push subscription, capability
actions, structured tool inspectors, and a keyboard-first command palette.
Short transcripts retain normal document flow, while long transcripts are
virtualized. Activity-group headers are the sole sticky transcript landmark.

## Dashboard UI principle

Prefer content over labels and chrome: expanded technical payloads should be
concise and scannable, avoiding headings that merely restate the containing
action. Add explanation only when it resolves ambiguity, communicates an error,
or makes a safety boundary clear.

## Security boundaries

Keep the daemon bound to loopback and publish it only through a private HTTPS
reverse proxy such as Tailscale Serve; do not use Funnel. The application token
remains required even when a proxy supplies identity headers.

Every API request except health requires a bearer or `x-dashboard-token`
credential. Requests that include an `Origin` must match the exact allow-list,
and state-changing requests must include an allow-listed origin, except the
Bearer-authenticated external create route documented below. WebSocket
upgrades require the same origin and authenticate with the first bounded
message, never a URL token. The PWA asks for the token on first use and stores it
in browser local storage; it does not embed the token in its build. Machine
clients may use `POST /api/external/v1/projects/:projectId/threads` with
`Authorization: Bearer`; this route accepts originless requests and requires
`externalRef`, `title`, and a nonblank `prompt`. The reference is persisted and
idempotent for the command payload; reuse with different input returns a
conflict.

Workspace and session launch requests use IDs from trusted indexes, never raw
paths or flags. Uploads are bounded, server-owned temporary files and are removed
after command acknowledgement. Dashboard runtime mutations reserve a durable
command intent before side effects. Start/restart plans reserve one runtime
identity and bounded recovery configuration; prompts, images, action inputs, and
raw credentials are not persisted in those plans. Migration 21 adds intent state
and managed-launch readiness evidence without rewriting existing receipts.

Runtime recovery runs after bridge/index startup and before HTTP admission. A
matching readiness/stopped marker can establish the original result; missing or
ambiguous evidence returns `runtime-command-uncertain` rather than blindly
replaying an operation. The browser does not automatically retry this domain
error. An initial prompt is best-effort: a successful launch acknowledges runtime
readiness, not completion or delivery of a model turn.

New bridge-command receipts persist only bounded `{accepted:true}` replay data;
the first response may return the original ACK output. Old completed receipts
retain their original results. For an external runtime, `stopped:true` denotes
removal from dashboard control, not proof that its OS process terminated. Managed
stop requires host evidence plus local PID absence, including when talking to an
older host that returned permissive ACKs. Ordinary deployment must not restart
the runtime or process host.

Missing usage or VAPID configuration is isolated from runtime control and in-app
notifications.

## Intentional limits

The dashboard has no terminal emulator, arbitrary command route, cold-start Sesh
launch requirement, multi-user authentication, public exposure,
delegate-child control, offline command queue, or transcript database. Pi's
native extensions and TUI remain the source of truth for local terminal
behavior.

Pi 0.84.1 exposes some lifecycle operations only through command context, so the
remote adapter advertises only headless operations that are safe from its socket
callback. Managed launch and restart are the supported browser lifecycle paths. See
[extension-contributions.md](extension-contributions.md) for the exact removal
conditions of installed host-API shims.

## Validation

Start with the dashboard scopes relevant to the change:

```sh
bun run typecheck:packages
bun run typecheck:apps
bun run --filter <changed-dashboard-workspace> test
```

Before deployment or after a cross-cutting dashboard change, run the combined
validation and build:

```sh
bun run check
bun run workspace:build
```

The checked-in mobile Playwright coverage mocks the snapshot API and exercises
the dashboard and launch routes:

```sh
bun run --filter @pi-dashboard/web test:e2e
```

Real Pi runtime integration and browser-device push delivery remain opt-in
checks because they require local credentials and an HTTPS secure context.
