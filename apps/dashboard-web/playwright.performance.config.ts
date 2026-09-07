import { defineConfig, devices } from '@playwright/test';

const webPort = Number(process.env.PI_DASHBOARD_PERF_WEB_PORT ?? 43_274);
const apiPort = Number(process.env.PI_DASHBOARD_PERF_API_PORT ?? 43_273);
const diagnostic = process.env.PI_DASHBOARD_PERF_DIAGNOSTIC === '1';

export default defineConfig({
  testDir: './e2e',
  testMatch: /performance\.spec\.ts/u,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${webPort}`,
    serviceWorkers: 'block',
    trace: diagnostic ? 'retain-on-failure' : 'off',
  },
  webServer: {
    command: `node ../../scripts/dashboard-performance-web.mjs serve --port ${webPort} --api-port ${apiPort}`,
    url: `http://127.0.0.1:${webPort}`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
