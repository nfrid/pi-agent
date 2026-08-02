# Remote Pi Dashboard v1

This tree contains the first self-hosted dashboard vertical slice. It keeps Pi as a normal interactive process in tmux and uses structured Pi events/session JSONL; it does **not** scrape terminal output or expose a shell endpoint.

## Layout

- `packages/dashboard-protocol`: versioned JSONL DTOs, bounded parsing, and launch/command validation.
- `packages/activity-model`: shared pure grouping/title model copied from the existing activity-groups implementation. The TUI extension remains unchanged and `extensions/activity-groups/model.ts` exposes the shared entry point.
- `extensions/remote-control`: Pi 0.82.1 bridge. Set `PI_DASHBOARD_SOCKET` to opt in; managed launches also set the runtime ID and short-lived token.
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

Start the daemon after building:

```sh
pnpm --filter @pi-dashboard/server build
node apps/dashboard-server/dist/index.js
```

The daemon prints a per-install browser token. Build the web app with `VITE_DASHBOARD_URL` (when server and web are on different origins) and `VITE_DASHBOARD_TOKEN`, then serve `apps/dashboard-web/dist` over HTTPS. For local development, run `pnpm --filter @pi-dashboard/web dev` and include its origin in `PI_DASHBOARD_ORIGINS`.

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

Do not put the generated token in a public URL. The HTTP API requires an exact allow-listed `Origin` and bearer/`x-dashboard-token`; state-changing requests require an origin. WebSocket upgrades require the same origin and token. The Unix socket is mode 0600 and frames are bounded; managed registration tokens expire after one minute and are consumed once. Workspace/session launch inputs are IDs from trusted indexes, never arbitrary paths or flags. External runtimes can be controlled but their tmux windows are never removed by dashboard stop.

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

The bridge sends a full snapshot on every connection, sequence-checks events, reconnects with bounded backoff, and serializes commands with acknowledgements. The browser refetches `/api/snapshot` after reconnect. Session indexing is rebuildable from Pi headers and incrementally invalidated; malformed historical files are skipped. Push, usage, Sesh refresh, and metrics-like history failures are isolated from control.

Unit/integration coverage includes protocol rejection/size bounds, shared activity grouping, first-answer-wins broker behavior, Sesh normalization, argv-safe tmux placement, security boundaries, and session index rebuild. Real Pi/tmux/Sesh and browser-device push tests are opt-in and are not run by normal CI because they require a user's tmux server, credentials, and HTTPS secure context. Playwright is not installed in the base repository; the mobile browser path is validated by the production Vite build and should be exercised with the team's existing browser harness before deployment.

## Deliberate v1 limits

There is no terminal emulator, arbitrary command route, cold-start Sesh path, worktree automation, multi-user auth, public exposure, delegate-child control, offline queue, or transcript database. The small metrics/usage surface is intentionally a live operational view. Native Pi extensions and TUI behavior remain the source of truth for the local terminal.
