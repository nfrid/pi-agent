# Dashboard deployment

The production dashboard is served from generated `dist/` directories by the macOS LaunchAgent `com.pi.dashboard`, which runs `node scripts/dashboard-dev.mjs serve` and owns only the API daemon and Vite preview. Its children remain in the LaunchAgent process group so a forced restart cannot orphan either service. Managed headless children are owned by `com.pi.dashboard-runtime-host`; phase-1 durable shell jobs are owned by the separate `com.pi.dashboard-process-host` LaunchAgent. The shell-job control socket is `PI_PROCESS_HOST_SOCKET`, separate from both the runtime bridge and dashboard HTTP. Changes under `apps/dashboard-*`, `packages/dashboard-*`, `packages/background-jobs`, `packages/activity-model`, or `packages/codex-usage` are not deployed until the production bundles are rebuilt and the service is restarted. Ordinary dashboard deploy must not restart the runtime or process host.

## Browser-test guidance

- Read `apps/dashboard-web/playwright.config.ts` before adding hover or responsive assertions. The default Playwright configuration may only define a mobile project; desktop-only behavior needs an explicit desktop context or project.
- Run filtered Playwright tests with `bun run --filter @pi-dashboard/web test:e2e -- --grep "<test name>"`.
- Hidden tooltip, preview, and accessibility-only DOM can still make Playwright text locators ambiguous. Avoid duplicating decorative text in DOM nodes when `data-*` attributes or CSS-generated content suffice. Otherwise, scope text assertions to the semantic transcript or control that owns the text.
- The default test ports are shared process resources. If either is occupied, identify its owner rather than stopping an unfamiliar process, choose an unused pair, and run with `PI_DASHBOARD_E2E_PORT=<port> PI_DASHBOARD_E2E_API_PORT=<port> bun run --filter @pi-dashboard/web test:e2e`.

## Dirty-tree deployment

The deployment steps below assume the dashboard build contains only the intended work. Before building, follow `docs/development-workflow.md` and inspect both `HEAD` and the working tree.

If unrelated changes are present, do not deploy a build from the mixed checkout. Commit the owned change first, then either wait for the shared checkout to become suitable or build the exact intended commit in an isolated detached worktree. Copy only that build's generated dashboard `dist/` artifacts into the production checkout before restarting the service, and report the deployed commit. Validation run in a mixed checkout does not prove the isolated commit.

After validating a dashboard-affecting change:

1. Ensure the customized `deploy/com.pi.dashboard.plist` is installed at `~/Library/LaunchAgents/com.pi.dashboard.plist` after every template change. Reload only `com.pi.dashboard` with `launchctl bootout`/`bootstrap`; install and start `deploy/com.pi.dashboard-runtime-host.plist` and `deploy/com.pi.dashboard-process-host.plist` separately once. The dashboard deploy command verifies that the installed agent runs `scripts/dashboard-dev.mjs serve` with `AbandonProcessGroup=false` and refuses to restart a stale direct-API template.
2. Build every dashboard workspace dependency and restart the production dashboard service from the repository root so both the server and web preview load the new bundles:
   `bun run dashboard:deploy`
   The deploy script runs `workspace:build` before restarting `com.pi.dashboard`; if the build fails, the running service is not restarted. Do not include either sidecar in ordinary dashboard deploy restarts.
3. The runner loads `.env.dashboard` from the repository root before applying LaunchAgent environment overrides; keep the dashboard token and other secrets in that file, not in the plist. Source `.env.dashboard` without printing its token, then read the installed LaunchAgent's API/web ports (without printing them) before waiting for both the bridge socket and HTTP health endpoint:
   `set -a; [ ! -f .env.dashboard ] || . ./.env.dashboard; set +a; launchagent="$HOME/Library/LaunchAgents/com.pi.dashboard.plist"; PI_DASHBOARD_PORT="$(plutil -extract EnvironmentVariables.PI_DASHBOARD_PORT raw -o - "$launchagent")"; PI_DASHBOARD_WEB_PORT="$(plutil -extract EnvironmentVariables.PI_DASHBOARD_WEB_PORT raw -o - "$launchagent")"; ready=; for i in $(seq 1 50); do [ -S dashboard/bridge.sock ] && curl -fsS --max-time 1 "http://127.0.0.1:${PI_DASHBOARD_PORT}/api/health" >/dev/null && { ready=1; break; }; sleep 0.2; done; [ "$ready" = 1 ]`
4. Verify the web entrypoint returns `200`, the authenticated protocol-v3 browser queries load over POST, and the removed finite/session endpoints remain gone. The API enforces the production web origin even for token-authenticated probes:
   `origin="http://127.0.0.1:${PI_DASHBOARD_WEB_PORT}"; curl -fsS -o /dev/null "$origin/" && curl -fsS -H "origin: $origin" -H "content-type: application/json" -H "x-dashboard-token: $PI_DASHBOARD_AUTH_TOKEN" -H "x-dashboard-protocol-version: 3" --data 'null' "http://127.0.0.1:${PI_DASHBOARD_PORT}/trpc/protocolInfo" >/dev/null && curl -fsS -H "origin: $origin" -H "content-type: application/json" -H "x-dashboard-token: $PI_DASHBOARD_AUTH_TOKEN" -H "x-dashboard-protocol-version: 3" --data '{"protocolVersion":3}' "http://127.0.0.1:${PI_DASHBOARD_PORT}/trpc/shellSnapshot" >/dev/null && test "$(curl -s -o /dev/null -w '%{http_code}' -H "origin: $origin" -H "x-dashboard-token: $PI_DASHBOARD_AUTH_TOKEN" "http://127.0.0.1:${PI_DASHBOARD_PORT}/trpc/bootstrap?input=%7B%22protocolVersion%22%3A1%7D")" = 404 && test "$(curl -s -o /dev/null -w '%{http_code}' -H "origin: $origin" -H "x-dashboard-token: $PI_DASHBOARD_AUTH_TOKEN" "http://127.0.0.1:${PI_DASHBOARD_PORT}/api/sessions/example")" = 404`
5. If startup fails, inspect `dashboard/serve.log` and `dashboard/serve.error.log` before making further changes.

The LaunchAgent templates include `~/.bun/bin` in `PATH`; preserve that entry when installing them so managed agents and background jobs can run workspace commands. Phase 1 does not migrate delegate execution; that remains pending. Do not delete or clean `apps/**/dist` or `packages/**/dist` while the production service is running: the preview server returns `404` without its bundle. Do not run tests or temporary dashboard servers against the production `dashboard/bridge.sock`; always provide an isolated `stateDir` or `socketPath`. A successful build alone is not a deployment, and a web `200` alone does not prove the bridge daemon is healthy.

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
