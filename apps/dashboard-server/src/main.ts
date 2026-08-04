import { createDaemon } from './create-daemon.js';

const server = await createDaemon();
await server.start();
process.stdout.write(
  `Pi Dashboard listening on http://127.0.0.1:${server.port}\nBridge socket: ${server.socketPath}\nBrowser token: ${server.token}\n`,
);
const shutdown = () => {
  void server.stop().finally(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
