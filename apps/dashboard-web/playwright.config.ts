import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PI_DASHBOARD_E2E_PORT ?? 43_174);
const apiPort = Number(process.env.PI_DASHBOARD_E2E_API_PORT ?? 43_173);

export default defineConfig({
  testDir: './e2e',
  timeout: 15_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  webServer: {
    command: `PI_DASHBOARD_PORT=${apiPort} bun run dev -- --host 127.0.0.1 --port ${port}`,
    port,
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
      grepInvert: /@desktop/,
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      grep: /@desktop/,
    },
  ],
});
