import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@pi-dashboard/protocol': path.resolve(__dirname, '../../packages/dashboard-protocol/src/index.ts'),
      '@pi-dashboard/activity-model': path.resolve(__dirname, '../../packages/activity-model/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PI_DASHBOARD_WEB_PORT ?? 4174),
  },
});
