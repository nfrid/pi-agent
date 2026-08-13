# Remote Pi dashboard

The dashboard is a self-hosted web interface for local Pi runtimes. Pi remains a
normal interactive process inside tmux; the dashboard consumes structured Pi
events and persisted session JSONL. It does not scrape terminal output, expose a
shell endpoint, or copy transcripts into its metadata database.

## Packages and applications

- `extensions/remote-control` adapts Pi runtime events, commands, interactions,
  capabilities, models, and thinking levels to the bounded Unix-socket protocol.
- `packages/dashboard-protocol` owns the versioned wire schemas, parsers, limits,
  validation, and redaction rules.
- `packages/dashboard-domain` owns framework-independent runtime and transcript
  projections.
- `packages/dashboard-client` owns authenticated HTTP, resumable SSE, token
  storage, query/mutation factories, and the browser live store.
- `packages/extension-contributions` defines schema-first extension actions,
  renderers, inspectors, and interactions. See
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
pnpm install
cp .env.dashboard.example .env.dashboard
# Replace PI_DASHBOARD_AUTH_TOKEN and adjust origins if needed.
pnpm dashboard:dev
```

`pnpm dashboard:daemon` and `pnpm dashboard:web` run either side separately.
Root environment variables override `.env.dashboard`; the private environment
file is gitignored. When the daemon and web app use different origins, set
`VITE_DASHBOARD_URL` for the web build and allow that exact origin through
`PI_DASHBOARD_ORIGINS`.

A manually started Pi process registers when the extension is loaded and the
bridge socket is configured:

```sh
PI_DASHBOARD_SOCKET="$HOME/.pi/agent/dashboard/bridge.sock" pi
```

Dashboard launches use a fixed `pi` argv in a new tmux window, an absolute
validated workspace, and one window per managed runtime. The workspace must
belong to an active tmux session discovered by Sesh; dormant Sesh entries are
not launch targets.

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
| `PI_DASHBOARD_EXPERIMENTAL_PI_SERVER=1` + `PI_DASHBOARD_PI_SERVER_SOCKET` | Explicitly enable the bounded external Pi server experiment; see [pi-server-experiment.md](pi-server-experiment.md). |

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
  runtime-service       launch, restart, stop, commands, interactions, rename
  session-service       session catalogue and transcript access
  workspace-service     Sesh catalogue and refresh persistence
  notification-service  runtime-derived notifications and push fan-out
  usage-service         bounded provider cache and request coalescing
  upload-service        bounded image validation, ownership, and cleanup
repositories/
  migrations                     numbered idempotent SQLite migrations
  sqlite-metadata-repository     workspace/runtime/session/launch metadata
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

Managed runtime placement and hashed credentials persist in SQLite so reconnects
survive socket churn and daemon restart. External runtimes can be controlled,
but the dashboard never removes their tmux windows. Force-stop is available only
for managed runtimes.

## Browser surface

The TanStack Router tree exposes:

- `/` — dashboard overview;
- `/sessions/:id` — persisted and live transcript;
- `/workspaces/:id` — workspace details;
- `/runtimes/:id` — runtime details and controls;
- `/new` — managed runtime launch.

The UI supports launch/restart/stop, prompt/steer/follow-up input, image
attachments, abort, model and thinking selection, session rename, interaction
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
and state-changing requests must include an allow-listed origin. WebSocket
upgrades require the same origin and authenticate with the first bounded
message, never a URL token. The PWA asks for the token on first use and stores it
in browser local storage; it does not embed the token in its build.

Workspace and session launch requests use IDs from trusted indexes, never raw
paths or flags. Uploads are bounded, server-owned temporary files and are removed
after command acknowledgement. Missing usage or VAPID configuration is isolated
from runtime control and in-app notifications.

## Intentional limits

The dashboard has no terminal emulator, arbitrary command route, cold-start Sesh
path, multi-user authentication, public exposure,
delegate-child control, offline command queue, or transcript database. Pi's
native extensions and TUI remain the source of truth for local terminal
behavior.

Pi 0.84.1 exposes some lifecycle operations only through command context, so the
remote adapter advertises only headless operations that are safe from its socket
callback. Managed launch and restart are the supported browser lifecycle paths. See
[extension-contributions.md](extension-contributions.md) for the exact removal
conditions of installed host-API shims.

## Validation

Run the relevant checks from the repository root:

```sh
pnpm run check
pnpm run workspace:typecheck
pnpm run workspace:test
pnpm run workspace:build
```

The checked-in mobile Playwright coverage mocks the snapshot API and exercises
the dashboard and launch routes:

```sh
pnpm --filter @pi-dashboard/web test:e2e
```

Real Pi/tmux/Sesh lifecycle and browser-device push delivery remain opt-in
integration checks because they require a user's tmux server, credentials, and
an HTTPS secure context.
