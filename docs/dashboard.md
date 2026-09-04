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
[dashboard-deployment.md](dashboard-deployment.md).

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

## Architecture

```text
Pi extension events
  -> extensions/remote-control
  -> bounded JSONL over a user-private Unix socket
  -> RuntimeRegistry and DashboardApplication
  -> canonical event stream + runtime/transcript projections
  -> authenticated HTTP snapshots and resumable SSE
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

`DashboardEventStream` is the daemon-global cursor and bounded replay log. Every
publication receives one cursor before subscribers are notified. The browser
connects with a header-authenticated fetch-based SSE client, rejects duplicate
or older records, and reconnects from its last accepted cursor. A cursor outside
the retained window returns a replay gap, causing the client to fetch a fresh
authoritative snapshot before reconnecting. Cursor ordering is scoped by
`serverId`, so a daemon restart can safely begin again at a lower cursor.

`DashboardLiveStore` is the browser's single external store for normalized
snapshots, entity indexes, bounded event history, transcript projections,
connection state, and daemon-generation acceptance. Session hydration installs
an HTTP projection at its cursor and applies only newer buffered events through
the shared transcript reducer. Persisted/live convergence uses explicit runtime,
session, message, and tool identities rather than recursively inferring IDs from
provider payloads.

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
after command acknowledgement. Dashboard mutation command IDs are protected
against concurrent duplicates and response-loss retries once their receipt is
durable; a daemon crash after the runtime side effect but before receipt
persistence can still permit one duplicate on retry. Missing usage or VAPID
configuration is isolated from runtime control and in-app notifications.

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

Real Pi/Sesh discovery and browser-device push delivery remain opt-in
integration checks because they require local credentials and an HTTPS secure
context.
