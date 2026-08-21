# Dashboard deployment

The production dashboard is served from generated `dist/` directories by the macOS LaunchAgent `com.pi.dashboard`; managed headless children are owned by the separate `com.pi.dashboard-runtime-host` LaunchAgent. Changes under `apps/dashboard-*`, `packages/dashboard-*`, `packages/activity-model`, or `packages/codex-usage` are not deployed until the production bundles are rebuilt and the service is restarted. Ordinary dashboard deploy must not restart the runtime host.

## Browser-test guidance

- Read `apps/dashboard-web/playwright.config.ts` before adding hover or responsive assertions. The default Playwright configuration may only define a mobile project; desktop-only behavior needs an explicit desktop context or project.
- Run filtered Playwright tests with `pnpm --filter @pi-dashboard/web exec playwright test --grep "<test name>"`. Do not insert `--` before `--grep`: it can be forwarded as a positional argument and cause the full suite to run.
- Hidden tooltip, preview, and accessibility-only DOM can still make Playwright text locators ambiguous. Avoid duplicating decorative text in DOM nodes when `data-*` attributes or CSS-generated content suffice. Otherwise, scope text assertions to the semantic transcript or control that owns the text.
- The default test ports are shared process resources. If either is occupied, identify its owner rather than stopping an unfamiliar process, choose an unused pair, and run with `PI_DASHBOARD_E2E_PORT=<port> PI_DASHBOARD_E2E_API_PORT=<port> pnpm --filter @pi-dashboard/web test:e2e`.

## Dirty-tree deployment

The deployment steps below assume the dashboard build contains only the intended work. Before building, follow `docs/development-workflow.md` and inspect both `HEAD` and the working tree.

If unrelated changes are present, do not deploy a build from the mixed checkout. Commit the owned change first, then either wait for the shared checkout to become suitable or build the exact intended commit in an isolated detached worktree. Copy only that build's generated dashboard `dist/` artifacts into the production checkout before restarting the service, and report the deployed commit. Validation run in a mixed checkout does not prove the isolated commit.

After validating a dashboard-affecting change:

1. Build every dashboard workspace dependency and restart the production dashboard service from the repository root so both the server and web preview load the new bundles:
   `pnpm run dashboard:deploy`
   The deploy script runs `workspace:build` before restarting `com.pi.dashboard`; if the build fails, the running service is not restarted. Install and start `deploy/com.pi.dashboard-runtime-host.plist` separately once; do not include it in ordinary dashboard deploy restarts.
2. Source `.env.dashboard` without printing its token, then wait for both the bridge socket and HTTP health endpoint:
   `set -a; [ ! -f .env.dashboard ] || . ./.env.dashboard; set +a; ready=; for i in $(seq 1 50); do [ -S dashboard/bridge.sock ] && curl -fsS --max-time 1 "http://127.0.0.1:${PI_DASHBOARD_PORT:-4173}/api/health" >/dev/null && { ready=1; break; }; sleep 0.2; done; [ "$ready" = 1 ]`
3. Verify the web entrypoint returns `200`, the authenticated protocol-v2 browser queries load over POST, and the removed finite/session endpoints remain gone. The API enforces the production web origin even for token-authenticated probes:
   `origin="http://127.0.0.1:${PI_DASHBOARD_WEB_PORT:-4174}"; curl -fsS -o /dev/null "$origin/" && curl -fsS -H "origin: $origin" -H "content-type: application/json" -H "x-dashboard-token: $PI_DASHBOARD_AUTH_TOKEN" -H "x-dashboard-protocol-version: 2" --data 'null' "http://127.0.0.1:${PI_DASHBOARD_PORT:-4173}/trpc/protocolInfo" >/dev/null && curl -fsS -H "origin: $origin" -H "content-type: application/json" -H "x-dashboard-token: $PI_DASHBOARD_AUTH_TOKEN" -H "x-dashboard-protocol-version: 2" --data '{"protocolVersion":2}' "http://127.0.0.1:${PI_DASHBOARD_PORT:-4173}/trpc/shellSnapshot" >/dev/null && test "$(curl -s -o /dev/null -w '%{http_code}' -H "origin: $origin" -H "x-dashboard-token: $PI_DASHBOARD_AUTH_TOKEN" "http://127.0.0.1:${PI_DASHBOARD_PORT:-4173}/trpc/bootstrap?input=%7B%22protocolVersion%22%3A1%7D")" = 404 && test "$(curl -s -o /dev/null -w '%{http_code}' -H "origin: $origin" -H "x-dashboard-token: $PI_DASHBOARD_AUTH_TOKEN" "http://127.0.0.1:${PI_DASHBOARD_PORT:-4173}/api/sessions/example")" = 404`
4. If startup fails, inspect `dashboard/serve.log` and `dashboard/serve.error.log` before making further changes.

Do not delete or clean `apps/**/dist` or `packages/**/dist` while the production service is running: the preview server returns `404` without its bundle. Do not run tests or temporary dashboard servers against the production `dashboard/bridge.sock`; always provide an isolated `stateDir` or `socketPath`. A successful build alone is not a deployment, and a web `200` alone does not prove the bridge daemon is healthy.
