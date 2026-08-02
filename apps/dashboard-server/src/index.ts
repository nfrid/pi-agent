import { createDashboardServer } from './http.js';

export { createDashboardServer } from './http.js';
export * from './metadata.js';
export * from './runtime-manager.js';
export * from './runtime-registry.js';
export * from './security.js';
export * from './sesh.js';
export * from './session-index.js';
export * from './tmux.js';

const isMain =
  process.argv[1] &&
  new URL(`file://${process.argv[1]}`).href === import.meta.url;
if (isMain) {
  const server = await createDashboardServer();
  await server.start();
  process.stdout.write(
    `Pi Dashboard listening on http://127.0.0.1:${server.port}\nBridge socket: ${server.socketPath}\nBrowser token: ${server.token}\n`,
  );
  const shutdown = () => {
    void server.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
