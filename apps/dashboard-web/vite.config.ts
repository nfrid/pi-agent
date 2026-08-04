import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const dashboardTarget = `http://127.0.0.1:${process.env.PI_DASHBOARD_PORT ?? 4173}`;
const proxy = {
  '/api': { target: dashboardTarget },
  '/ws': { target: dashboardTarget, ws: true },
};

export default defineConfig({
  // Tailwind v4 is utility-only here; styles.css intentionally does not import preflight.
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@pi-dashboard/client': path.resolve(
        __dirname,
        '../../packages/dashboard-client/src/index.ts',
      ),
      '@pi-dashboard/protocol': path.resolve(
        __dirname,
        '../../packages/dashboard-protocol/src/index.ts',
      ),
      '@pi-dashboard/activity-model': path.resolve(
        __dirname,
        '../../packages/activity-model/src/index.ts',
      ),
      '@pi-dashboard/domain': path.resolve(
        __dirname,
        '../../packages/dashboard-domain/src/index.ts',
      ),
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PI_DASHBOARD_WEB_PORT ?? 4174),
    proxy,
  },
  preview: {
    host: '127.0.0.1',
    port: Number(process.env.PI_DASHBOARD_WEB_PORT ?? 4174),
    allowedHosts: ['pi.nfrid.me'],
    proxy,
  },
});
