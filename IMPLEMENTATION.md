# Remote Pi Dashboard v1

This tree contains the first self-hosted dashboard vertical slice. It keeps Pi as a normal interactive process in tmux and uses structured Pi events/session JSONL; it does **not** scrape terminal output or expose a shell endpoint.

## Layout

- `packages/dashboard-protocol`: versioned JSONL DTOs, bounded parsing, and launch/command validation.
- `packages/activity-model`: canonical pure grouping/title model consumed by both the TUI extension and dashboard web renderer. Compatibility imports under `extensions/activity-groups` only re-export it.
- `extensions/remote-control`: Pi 0.82.1 bridge. It is safe to load globally, defaults to `~/.pi/agent/dashboard/bridge.sock`, and quietly retries while no daemon is present. Managed launches also set a one-time launch credential and a separate persistent runtime identity credential.
- `apps/dashboard-server`: localhost HTTP/WebSocket daemon, Unix bridge socket, Sesh/tmux adapters, runtime registry, session index, metadata SQLite, interaction broker transport, usage and isolated Web Push adapters.
- `apps/dashboard-web`: mobile React/Vite PWA with dashboard, workspace, session, runtime and launch routes.

## Requirements and setup

Node **25+** is required. Node 25's maintained built-in `node:sqlite` is used for dashboard metadata; session transcripts remain Pi JSONL files and are never copied to SQLite. Install and validate from the repository root:

```sh
pnpm install
pnpm run check
pnpm run workspace:typecheck
pnpm run workspace:test
pnpm run workspace:build
```

For local development, copy `.env.dashboard.example` to `.env.dashboard`, set a private token, then start both services with one command:

```sh
pnpm dashboard:dev
```

Use `pnpm dashboard:daemon` or `pnpm dashboard:web` to run only one side. The private `.env.dashboard` file is gitignored; root environment variables override values from it. For a production daemon after building:

```sh
pnpm --filter @pi-dashboard/server build
node apps/dashboard-server/dist/index.js
```

The daemon prints a per-install browser token. Build the web app with `VITE_DASHBOARD_URL` only when server and web are on different origins, then serve `apps/dashboard-web/dist` over HTTPS. The PWA never embeds the auth token in its build: on first load it asks for the printed token and keeps it in browser local storage. WebSocket authentication is a bounded first `{type:"auth",token}` message; the token is never placed in a URL. For local development, run `pnpm --filter @pi-dashboard/web dev` and include its origin in `PI_DASHBOARD_ORIGINS`.

A Pi process registers when the extension is loaded and these variables are present:

```sh
PI_DASHBOARD_SOCKET="$HOME/.pi/agent/dashboard/bridge.sock" pi
```

Dashboard launches use `tmux new-window -d -P` with a fixed `pi` argv, an absolute validated workspace, and one window per runtime. A workspace must already have an active tmux session discovered by Sesh; dormant Sesh entries are intentionally rejected in v1.

## Environment

| Variable | Purpose |
| --- | --- |
| `PI_DASHBOARD_HOST` / `PI_DASHBOARD_PORT` | bind address/port; defaults to `127.0.0.1`/ephemeral |
| `PI_DASHBOARD_SOCKET` | user-private Unix JSONL bridge socket |
| `PI_DASHBOARD_AUTH_TOKEN` | stable browser token; otherwise generated at startup |
| `PI_DASHBOARD_ORIGINS` | comma-separated exact browser origins |
| `PI_DASHBOARD_STATE_DIR` | metadata/socket directory (0700) |
| `PI_SESSION_DIR` | optional Pi session root override |
| `PI_DASHBOARD_CODEX_AUTH` | optional usage adapter credential |
| `PI_DASHBOARD_VAPID_PUBLIC_KEY`, `PI_DASHBOARD_VAPID_PRIVATE_KEY`, `PI_DASHBOARD_VAPID_SUBJECT` | optional Web Push configuration |
| `PI_DASHBOARD_NOTIFY_SETTLED=1` | opt in to noisier settled notifications |

Do not put the generated token in a public URL. The HTTP API requires an exact allow-listed `Origin` and bearer/`x-dashboard-token`; state-changing requests require an origin. WebSocket upgrades require the same origin, then authenticate with the first message (not a query parameter), preserving the same origin/CSRF boundary. The Unix socket is mode 0600 and frames are bounded; managed registration tokens expire after one minute and are consumed once. Workspace/session launch inputs are IDs from trusted indexes, never arbitrary paths or flags. External runtimes can be controlled but their tmux windows are never removed by dashboard stop. Force-stop is rejected for external runtimes; managed stop requests graceful shutdown, bounded SIGTERM/SIGKILL fallback, then removes only its own window.

The dashboard has an explicit **Enable notifications** action. It requests browser permission only after that click, fetches the public VAPID key from authenticated `/api/push/vapid-public-key`, and stores the resulting subscription in SQLite. Waiting push notifications use stable `waiting-<runtime>` tags; resolving an interaction sends a tagged clear notification and marks the in-app event read. Missing VAPID configuration leaves in-app unread events and control paths working.

## macOS launchd and Tailscale Serve

Copy `deploy/com.pi.dashboard.plist` to `~/Library/LaunchAgents/`, adjust `WorkingDirectory` and `ProgramArguments` if the checkout is elsewhere, then:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pi.dashboard.plist
launchctl kickstart -k gui/$(id -u)/com.pi.dashboard
```

Keep the daemon bound to loopback. Publish only the HTTPS web/API reverse proxy through Tailscale Serve (never Funnel), for example:

```sh
tailscale serve --https=443 http://127.0.0.1:4174
```

If the web server is separate from the daemon, set `PI_DASHBOARD_ORIGINS` to its Tailscale HTTPS origin and keep the API token in the installed PWA's private configuration. Tailscale identity headers are not treated as authentication by default; the application token remains required.

## Reliability and tests

The bridge sends a full snapshot on every connection, sequence-checks events, reconnects with bounded backoff, and serializes commands with acknowledgements. Managed placement and hashed credentials are restored from mode-0600 metadata so reconnects survive socket churn and daemon restart; launch authorization is one-time and ongoing runtime identity is separate. The browser reconciles live message/tool items by stable IDs and refetches persisted sessions on settle/reconnect. Session indexing is rebuildable from Pi headers and incrementally invalidated; malformed historical files are skipped. Push, usage, Sesh refresh, and metrics-like history failures are isolated from control.

Unit/integration coverage includes protocol rejection/size bounds, shared activity grouping, first-answer-wins broker behavior, bridge broker transport, Sesh normalization, argv-safe tmux placement, HTTP auth/CORS, security boundaries, and session index rebuild. The checked-in Playwright mobile test mocks the snapshot API and verifies the dashboard and launch route; run it with `pnpm --filter @pi-dashboard/web test:e2e` after installing the Chromium browser. Real Pi/tmux/Sesh registration, managed lifecycle, and browser-device push delivery remain opt-in because they require a user's tmux server, credentials, and HTTPS secure context.

## Deliberate v1 limits

There is no terminal emulator, arbitrary command route, cold-start Sesh path, worktree automation, multi-user auth, public exposure, delegate-child control, offline queue, or transcript database. The small metrics/usage surface is intentionally a live operational view. Native Pi extensions and TUI behavior remain the source of truth for the local terminal.
