# Dashboard deployment

The production dashboard is served from generated `dist/` directories by the macOS LaunchAgent `com.pi.dashboard`. Changes under `apps/dashboard-*`, `packages/dashboard-*`, `packages/activity-model`, or `packages/codex-usage` are not deployed until the production bundles are rebuilt and the service is restarted.

## Browser-test guidance

- Read `apps/dashboard-web/playwright.config.ts` before adding hover or responsive assertions. The default Playwright configuration may only define a mobile project; desktop-only behavior needs an explicit desktop context or project.
- Run filtered Playwright tests with `pnpm --filter @pi-dashboard/web exec playwright test --grep "<test name>"`. Do not insert `--` before `--grep`: it can be forwarded as a positional argument and cause the full suite to run.
- Hidden tooltip, preview, and accessibility-only DOM can still make Playwright text locators ambiguous. Avoid duplicating decorative text in DOM nodes when `data-*` attributes or CSS-generated content suffice. Otherwise, scope text assertions to the semantic transcript or control that owns the text.

After validating a dashboard-affecting change:

1. Build every dashboard workspace dependency from the repository root:
   `pnpm run workspace:build`
2. Restart the production service so both the server and web preview load the new bundles:
   `launchctl kickstart -k "gui/$(id -u)/com.pi.dashboard"`
3. Source `.env.dashboard` without printing its token, then wait for both the bridge socket and HTTP health endpoint:
   `set -a; [ ! -f .env.dashboard ] || . ./.env.dashboard; set +a; ready=; for i in $(seq 1 50); do [ -S dashboard/bridge.sock ] && curl -fsS --max-time 1 "http://127.0.0.1:${PI_DASHBOARD_PORT:-4173}/api/health" >/dev/null && { ready=1; break; }; sleep 0.2; done; [ "$ready" = 1 ]`
4. Verify the web entrypoint returns `200`, the authenticated snapshot loads, and any changed runtime/session behavior works:
   `curl -fsS -o /dev/null "http://127.0.0.1:${PI_DASHBOARD_WEB_PORT:-4174}/" && curl -fsS -H "x-dashboard-token: $PI_DASHBOARD_AUTH_TOKEN" "http://127.0.0.1:${PI_DASHBOARD_PORT:-4173}/api/snapshot" >/dev/null`
5. If startup fails, inspect `dashboard/serve.log` and `dashboard/serve.error.log` before making further changes.

Do not delete or clean `apps/**/dist` or `packages/**/dist` while the production service is running: the preview server returns `404` without its bundle. Do not run tests or temporary dashboard servers against the production `dashboard/bridge.sock`; always provide an isolated `stateDir` or `socketPath`. A successful build alone is not a deployment, and a web `200` alone does not prove the bridge daemon is healthy.
