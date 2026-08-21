import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemon } from './create-daemon.js';

export * from './application/dashboard-application.js';
export * from './application/orchestration-service.js';
export type {
  DashboardConfiguration,
  DashboardDependencies,
  DashboardServerOptions,
} from './create-daemon.js';
export { createDaemon } from './create-daemon.js';
export * from './headless-runtime-provider.js';
export { createDashboardServer } from './http.js';
export * from './metadata.js';
export * from './project-resolver.js';
export * from './runtime-host.js';
export * from './runtime-manager.js';
export * from './runtime-registry.js';
export * from './security.js';
export * from './session-index.js';

/** Production/launchd entrypoint shared by dist/index.js and the dev wrapper. */
export async function runDashboard(): Promise<void> {
  const server = await createDaemon();
  await server.start();
  process.stdout.write(
    `Pi Dashboard listening on http://127.0.0.1:${server.port}\nBridge socket: ${server.socketPath}\nBrowser token: ${server.token}\n`,
  );
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void server.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await runDashboard();
