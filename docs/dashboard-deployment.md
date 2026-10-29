# Dashboard deployment

The production dashboard is served from generated `dist/` directories by the macOS LaunchAgent `com.pi.dashboard`, which runs `node scripts/dashboard-dev.mjs serve` and owns only the API daemon and Vite preview. Its children remain in the LaunchAgent process group so a forced restart cannot orphan either service. Managed dashboard Pi runtimes are owned by `com.pi.dashboard-runtime-host`; durable shell jobs and hosted delegate children are owned by the separate `com.pi.dashboard-process-host` LaunchAgent. The shell-job control socket is `PI_PROCESS_HOST_SOCKET`, separate from both the runtime bridge and dashboard HTTP. Client-only changes under `apps/dashboard-web` are deployed once its production bundle is rebuilt in the production checkout. Changes to the server, shared dashboard packages, preview configuration, or other runtime dependencies require the full build and dashboard service restart described below. Ordinary dashboard deploy must not restart the runtime or process host.

## Browser-test guidance

- Read `apps/dashboard-web/playwright.config.ts` before adding hover or responsive assertions. The default Playwright configuration may only define a mobile project; desktop-only behavior needs an explicit desktop context or project.
- Run filtered Playwright tests with `bun run --filter @pi-dashboard/web test:e2e -- --grep "<test name>"`.
- Replace CodeMirror composer text through keyboard select-all and native typing or `insertText`, not `locator.fill()` on its controlled contenteditable DOM. DOM-level fills can race draft synchronization and leave old text behind; keep the text and submission assertions intact.
- Hidden tooltip, preview, and accessibility-only DOM can still make Playwright text locators ambiguous. Avoid duplicating decorative text in DOM nodes when `data-*` attributes or CSS-generated content suffice. Otherwise, scope text assertions to the semantic transcript or control that owns the text.
- The default test ports are shared process resources. If either is occupied, identify its owner rather than stopping an unfamiliar process, choose an unused pair, and run with `PI_DASHBOARD_E2E_PORT=<port> PI_DASHBOARD_E2E_API_PORT=<port> bun run --filter @pi-dashboard/web test:e2e`.

## Dirty-tree deployment

The deployment steps below assume the dashboard build contains only the intended work. Before building, follow `docs/development-workflow.md` and inspect both `HEAD` and the working tree.

If unrelated changes are present, do not deploy a build from the mixed checkout. Commit the owned change first, then either wait for the shared checkout to become suitable or build the exact intended commit in an isolated detached worktree. Copy only that build's generated dashboard `dist/` artifacts into the production checkout, follow the matching client-only or full deployment path below, and report the deployed commit. Validation run in a mixed checkout does not prove the isolated commit.

After validating a client-only change under `apps/dashboard-web`, build it from the clean production checkout:

`bun run dashboard:web:build`

The running Vite preview reads the rebuilt `apps/dashboard-web/dist` bundle without a service restart. Confirm the web entrypoint returns `200`. Use the full deployment below if the change also touches workspace dependencies, server code, Vite or preview configuration, the LaunchAgent, or deployment scripts.

After validating a dashboard change that requires a service restart:

1. Ensure the customized `deploy/com.pi.dashboard.plist` is installed at `~/Library/LaunchAgents/com.pi.dashboard.plist` after every template change. Reload only `com.pi.dashboard` with `launchctl bootout`/`bootstrap`; install and start `deploy/com.pi.dashboard-runtime-host.plist` and `deploy/com.pi.dashboard-process-host.plist` separately once. The dashboard deploy command verifies that the installed agent runs `scripts/dashboard-dev.mjs serve` with `AbandonProcessGroup=false` and refuses to restart a stale direct-API template.
2. Build every dashboard workspace dependency and restart the production dashboard service from the repository root so both the server and web preview load the new bundles:
   `bun run dashboard:deploy`
   The deploy script runs `workspace:build` before restarting `com.pi.dashboard`; if the build fails, the running service is not restarted. Do not include either sidecar in ordinary dashboard deploy restarts.
3. The runner loads `.env.dashboard` from the repository root before applying LaunchAgent environment overrides; keep the dashboard token and other secrets in that file, not in the plist. Source `.env.dashboard` without printing its token, then read the installed LaunchAgent's API/web ports (without printing them) before waiting for both the bridge socket and HTTP health endpoint:
   `set -a; [ ! -f .env.dashboard ] || . ./.env.dashboard; set +a; launchagent="$HOME/Library/LaunchAgents/com.pi.dashboard.plist"; PI_DASHBOARD_PORT="$(plutil -extract EnvironmentVariables.PI_DASHBOARD_PORT raw -o - "$launchagent")"; PI_DASHBOARD_WEB_PORT="$(plutil -extract EnvironmentVariables.PI_DASHBOARD_WEB_PORT raw -o - "$launchagent")"; ready=; for i in $(seq 1 50); do [ -S dashboard/bridge.sock ] && curl -fsS --max-time 1 "http://127.0.0.1:${PI_DASHBOARD_PORT}/api/health" >/dev/null && { ready=1; break; }; sleep 0.2; done; [ "$ready" = 1 ]`
4. Verify the web entrypoint returns `200`, the authenticated protocol-v3 browser queries load over POST, and the removed finite/session endpoints remain gone. The API enforces the production web origin even for token-authenticated probes:
   `origin="http://127.0.0.1:${PI_DASHBOARD_WEB_PORT}"; curl -fsS -o /dev/null "$origin/" && curl -fsS -H "origin: $origin" -H "content-type: application/json" -H "x-dashboard-token: $PI_DASHBOARD_AUTH_TOKEN" -H "x-dashboard-protocol-version: 3" --data 'null' "http://127.0.0.1:${PI_DASHBOARD_PORT}/trpc/protocolInfo" >/dev/null && curl -fsS -H "origin: $origin" -H "content-type: application/json" -H "x-dashboard-token: $PI_DASHBOARD_AUTH_TOKEN" -H "x-dashboard-protocol-version: 3" --data '{"protocolVersion":3}' "http://127.0.0.1:${PI_DASHBOARD_PORT}/trpc/shellSnapshot" >/dev/null && test "$(curl -s -o /dev/null -w '%{http_code}' -H "origin: $origin" -H "x-dashboard-token: $PI_DASHBOARD_AUTH_TOKEN" "http://127.0.0.1:${PI_DASHBOARD_PORT}/trpc/bootstrap?input=%7B%22protocolVersion%22%3A1%7D")" = 404 && test "$(curl -s -o /dev/null -w '%{http_code}' -H "origin: $origin" -H "x-dashboard-token: $PI_DASHBOARD_AUTH_TOKEN" "http://127.0.0.1:${PI_DASHBOARD_PORT}/api/sessions/example")" = 404`
5. If startup fails, inspect `dashboard/serve.log` and `dashboard/serve.error.log` before making further changes.

The LaunchAgent templates include `~/.bun/bin` in `PATH`; preserve that entry when installing them so managed agents and background jobs can run workspace commands. A process-host restart terminates its shell jobs and hosted delegate children; arrange a quiet window or explicitly finish/stop them before upgrading that host. Do not delete or clean `apps/**/dist` or `packages/**/dist` while the production service is running: the preview server returns `404` without its bundle. Do not run tests or temporary dashboard servers against the production `dashboard/bridge.sock`; always provide an isolated `stateDir` or `socketPath`. A successful build alone is not a deployment, and a web `200` alone does not prove the bridge daemon is healthy.

## Local macOS notifications

By default, the optional native adapter opens the installed local Chrome PWA at
`/Applications/Pi Dashboard.app`, bundle ID
`com.google.Chrome.app.famamklipjamakjadikolcemgkfbbpek`, whose shortcut URL is
`http://127.0.0.1:4174/`. This default (`chrome-pwa`) never falls back to a
browser when the PWA is missing or its bundle/shortcut validation fails. Neither
mode targets the HTTPS app under `~/Applications/Chrome Apps.localized`.
Phone and public HTTPS clients continue to use Web Push.

Build and test without installation, permission prompts, or live notifications:

```sh
bun run dashboard:notifications test
```

On the production checkout, after approval, install the signed helper:

```sh
bun run dashboard:notifications install
```

This installs only `~/Applications/Pi Dashboard Notifications.app` and registers
it with LaunchServices. The stable helper bundle ID is
`com.pi.dashboard.notifications`. Its Pi icon and `LSUIElement` metadata belong
to the helper, not Chrome. The build uses ad-hoc signing by default. Set
`PI_NOTIFICATIONS_SIGN_IDENTITY` to a local signing identity for installations
that need a stable signing identity across updates. Verify macOS notification
permission after changing the signature or installing a replacement build.

Deploy the dashboard workspaces with the dashboard-only deployment procedure
above. Do not restart the runtime or process host. The API discovers the helper
at startup and owns its child and private Unix socket under
`<stateDir>/notifications/control.sock`. No extra LaunchAgent is required.
An absent or failed helper does not disable Web Push or runtime controls.

In the installed local PWA, open Settings and select "Enable Mac notifications".
Only this action requests macOS permission. Successful authorization removes
only the Web Push endpoint returned by this browser's `getSubscription()` and
unsubscribes that browser. Other devices remain subscribed. Enabling is
stored as one private boolean under `<stateDir>/notifications/enabled`. A
dashboard-only restart restores it only after the helper reports authorized OS
permission, even with the PWA closed. The adapter also checks permission before
restoring delivery after a helper disconnect. It does not store a token or Web
Push endpoint. OS permission persists separately. If macOS denies permission,
change it in System Settings > Notifications > Pi Dashboard Notifications and
retry. No
native delivery runs before an explicit enable. Authorization waits at most two
minutes; status and diagnostic requests wait at most three seconds. "Cancel
notification request" cancels activation, not the system dialog. A late grant
after cancellation or timeout cannot activate native delivery or remove the
browser subscription. Existing human-completion
opt-in and delegate suppression still apply.

Native notifications use the project as title and thread as subtitle. The
completion preview is the existing plain-text final-answer preview. Fault and
attention notifications retain their original technical title in the body,
followed by at most 240 characters of detail. Browser and in-app titles are
unchanged. Foreground suppression uses the same 30-second lease, refreshed every
10 seconds, with at most 32 tabs per recipient, even after Web Push unsubscribe.

Clicking sends one pending navigation to the authenticated local PWA and
activates the exact installed bundle through `NSWorkspace.openApplication`.
The PWA uses its SPA router for `/sessions/<encoded-session-id>`,
`/runtimes/<encoded-runtime-id>`, or the home fallback `/`.
The pending click expires after 60 seconds and the PWA acknowledges it after
navigation. The same path handles a cold helper launch by macOS; the helper
remembers only its socket path in its own UserDefaults. The API must be running
and the installed PWA must load the new bundle. Vite's same-origin proxy keeps
the exact `http://127.0.0.1:4174` Origin on native control, click-stream, and
foreground requests. Originless EventSource GETs require that exact PWA Referer.
The API still validates each native tRPC procedure, including procedures in a
batch. This design does not depend on
Chrome launch flags, app-shim argument forwarding, manifest launch defaults,
Accessibility permission, or browser scripting.

### Optional default-browser click target

To open notification links in Firefox when it is already your macOS default
browser, opt in on the Mac running the helper:

```sh
defaults write com.pi.dashboard.notifications dashboardOpenMode -string default-browser
```

Restart only the notification helper (quit `Pi Dashboard Notifications` in
Activity Monitor; the API relaunches it on the next control/delivery request),
or apply the preference before launching it. Do not restart the runtime or
process host. This persistent helper preference also applies when macOS
cold-launches it for a notification click. It does not change the default
browser, Firefox profiles, or Chrome configuration. To restore the original
behavior, write `chrome-pwa` instead; an absent key also means `chrome-pwa`.
Unknown mode strings reject clicks rather than falling back.

In `default-browser` mode the helper uses `NSWorkspace.open` with the validated
local URL. It does not inspect the Chrome PWA or send a `click` event over the
Unix socket, so an open PWA cannot consume this navigation. The socket still
carries notification delivery, permission/status requests, and diagnostics.
Both modes accept only `http://127.0.0.1:4174/`, `/sessions/<encoded-id>` and
`/runtimes/<encoded-id>`, without credentials, query strings, fragments, or
control characters in the decoded ID. No arbitrary origin or launch command
is configurable.

First open `http://127.0.0.1:4174/` in the target browser/profile and enter the
existing Dashboard token in its normal authentication prompt. Firefox does not
inherit Chrome's localStorage. A click without a saved token shows that same
prompt; submitting it reloads the current deep link, preserving the target.
Tokens are never placed in notification URLs, helper preferences, or launch
arguments. API authentication and Origin/Referer restrictions remain unchanged.
The Dashboard daemon and web preview must be running.

This option changes only where clicks open. Native permission/enablement and
foreground reporting still use the existing installed-PWA UI; enable native
notifications there first if they are not already enabled. The saved native
enablement survives closing the PWA. Ordinary browser tabs do not consume the
PWA click stream or report native foreground suppression, so notifications can
still arrive while the target session is focused in Firefox. The default browser
may open a new tab on each click; selecting a particular Firefox profile or
reusing a particular tab is outside this option. Web Push subscriptions and
delivery to other devices are unchanged.

`bun run dashboard:notifications test` exercises both dispatch modes with fake
openers: default PWA validation and socket-before-activation order, missing PWA
without fallback, direct browser opening without a PWA/socket event, opener
failure, unknown modes, and rejected URLs before any side effects. It neither
launches a browser nor modifies preferences or requests OS permission.

### Parent-owned live verification

After installation and dashboard-only deployment, set `API_ORIGIN` to the
loopback API origin and `SESSION_URL` to an exact local dashboard session URL.
Pass the existing dashboard token on standard input, never as a URL or argument:

```sh
printf %s "$PI_DASHBOARD_AUTH_TOKEN" | bun run dashboard:notifications click "$API_ORIGIN" "$SESSION_URL"
```

This authenticated diagnostic starts the helper if needed and invokes its same
click handler without requesting permission or sending a notification. A
`diagnostic` result means the helper accepted the target, not that macOS focus
or navigation has been observed. Verify that the existing local PWA becomes
active, switches to the exact thread, and leaves Arc and browser tabs alone.
Repeat with the PWA closed. Then enable notifications explicitly and verify one
approved real notification and its click, including a cold helper callback.
Check focused matching-thread suppression and delivery after lease expiry.
For the opt-in browser mode, repeat the diagnostic with the PWA open and
closed: the configured default browser must load the exact session while the
PWA stays on its previous route. Also check a fresh browser profile: the token
prompt must preserve the deep link after authentication. Repeat a real click
with a cold helper launch. A browser-mode `diagnostic` response reports only
that LaunchServices accepted the URL, not successful authentication or loading.
Neither build/tests nor the diagnostic response prove OS focus or notification
permission. These live checks remain deployment gates.

The desktop browser test intercepts the production PWA origin and fetches only
an isolated test preview. It does not connect to a production API or bridge.

## Project catalogue cutover gate

Use this additional gate when removing the legacy Sesh/workspace catalogue. Do
not deploy merely because the isolated checks pass.

### Before approval

1. Record the exact candidate commit and require a clean checkout. Confirm
   `extensions/notify-sound/index.ts` has no candidate diff.
2. Re-run scoped typechecks, focused server/protocol/client tests, and the
   project catalogue, project picker, project thread, and session reconnect
   browser tests from an isolated checkout.
3. Start a disposable daemon with isolated state, session directory, bridge
   socket, runtime-host socket, and a `PATH` without `sesh` or `tmux`. Verify
   authenticated health, Git and non-Git project adoption, restart, and
   idempotent project recovery. Remove every disposable process, socket, state
   directory, and temporary output-file link afterward.
4. Record the production dashboard and runtime-host service state, current
   commit, current dashboard bundle, database path, bridge socket, and the URL
   of the active session. Confirm the runtime-host service is healthy and will
   not be restarted by the dashboard deploy.
5. Take a consistent SQLite backup with the daemon stopped or with SQLite's
   online backup mechanism; copying only the main file while WAL writes are
   active is not a valid backup. Retain the previous dashboard `dist/` bundles.
6. Obtain explicit deployment approval. Project registration is deliberate:
   never import Sesh entries, historical session cwd values, or arbitrary
   runtime cwd values as projects.

### After the dashboard-only restart

1. Confirm the runtime-host PID/service instance did not change.
2. Confirm the bridge socket and health endpoint, web entrypoint, protocol-v3
   shell subscription, and authenticated project endpoints are available.
3. Confirm `/projects` loads, the legacy `/workspaces` UI and refresh/composer
   endpoints are absent, and no dashboard process requires `sesh` or `tmux`.
4. Register one approved Git project and one disposable non-Git directory.
   Verify main/worktree launch behavior, then remove the disposable project.
5. Confirm matched external runtimes and indexed sessions show the registered
   project and checkout. Confirm an unmatched cwd remains **Unassigned** and is
   still visible and controllable.
6. Open the pre-recorded active session URL, send a harmless interaction if
   approved, and verify reconnect after one dashboard-daemon restart while the
   runtime host remains running.
7. Check daemon and web logs for schema, feed replay, association, launch, and
   reconnect errors before declaring the cutover complete.

### Rollback

1. Stop only `com.pi.dashboard`; do not stop the runtime-host service or managed
   runtimes.
2. Restore the retained previous dashboard bundles and previous application
   commit. Restart `com.pi.dashboard`, then repeat bridge, health, web, active
   session, and reconnect checks.
3. The cutover keeps historical workspace/tmux SQLite migration columns and
   adds no destructive migration. Prefer code/bundle rollback without database
   restoration. Restore the consistent database backup only if data integrity
   requires it, with the dashboard daemon stopped.
4. If rollback cannot restore browser access promptly, leave the runtime host
   and active Pi processes running, keep the bridge/state files intact, and use
   the direct TUI session until the dashboard service is repaired.
