import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const workspaceRoot = path.resolve(__dirname, '../..');
const dashboardTarget = `http://127.0.0.1:${process.env.PI_DASHBOARD_PORT ?? 4173}`;
const proxy = {
  '/api': { target: dashboardTarget },
  '/trpc': { target: dashboardTarget },
};
const dashboardBuildId =
  process.env.PI_DASHBOARD_BUILD_ID?.trim() || randomUUID();
const versionPayload = `${JSON.stringify({ version: dashboardBuildId })}\n`;
const serviceWorkerSource = readFileSync(
  path.resolve(__dirname, 'public/sw.js'),
  'utf8',
);
const serviceWorkerMarker = "'__PI_DASHBOARD_BUILD_ID__'";

export function stampDashboardServiceWorker(
  source: string,
  buildId: string,
): string {
  if (!source.includes(serviceWorkerMarker))
    throw new Error('Dashboard service worker build marker is missing.');
  return source.replace(serviceWorkerMarker, JSON.stringify(buildId));
}

const serviceWorkerPayload = stampDashboardServiceWorker(
  serviceWorkerSource,
  dashboardBuildId,
);

function serveDashboardAsset(
  response: {
    setHeader(name: string, value: string): void;
    end(body: string): void;
  },
  contentType: string,
  payload: string,
): void {
  response.setHeader('Content-Type', contentType);
  response.setHeader('Cache-Control', 'no-store');
  response.end(payload);
}

function dashboardVersionPlugin(): Plugin {
  return {
    name: 'dashboard-version',
    configureServer(server) {
      server.middlewares.use('/version.json', (_request, response) => {
        serveDashboardAsset(response, 'application/json', versionPayload);
      });
      server.middlewares.use('/sw.js', (_request, response) => {
        serveDashboardAsset(
          response,
          'application/javascript',
          serviceWorkerPayload,
        );
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use('/version.json', (_request, response) => {
        serveDashboardAsset(response, 'application/json', versionPayload);
      });
      server.middlewares.use('/sw.js', (_request, response) => {
        serveDashboardAsset(
          response,
          'application/javascript',
          serviceWorkerPayload,
        );
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: versionPayload,
      });
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: serviceWorkerPayload,
      });
    },
  };
}

const config = defineConfig({
  envDir: workspaceRoot,
  define: {
    __DASHBOARD_BUILD_ID__: JSON.stringify(dashboardBuildId),
  },
  plugins: [react(), dashboardVersionPlugin()],
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
      '@pi-dashboard/extension-contributions': path.resolve(
        __dirname,
        '../../packages/extension-contributions/src/index.ts',
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

export default config;
