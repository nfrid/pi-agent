import { defaultProcessHostSocketPath } from '@pi-agent/background-jobs';
import { BackgroundJobHostService } from './background-job-host.js';
import { RuntimeHostService } from './runtime-host.js';

const socketPath =
  process.env.PI_DASHBOARD_RUNTIME_HOST_SOCKET ||
  `${process.env.PI_DASHBOARD_STATE_DIR || `${process.env.HOME || process.cwd()}/.pi/agent/dashboard`}/runtime-host.sock`;
const processSocketPath = defaultProcessHostSocketPath();
const stateDir =
  process.env.PI_DASHBOARD_STATE_DIR ||
  `${process.env.HOME || process.cwd()}/.pi/agent/dashboard`;
const host = new RuntimeHostService(socketPath);
const processHost = new BackgroundJobHostService(
  processSocketPath,
  `${stateDir}/background-jobs.sqlite`,
);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void Promise.all([host.close(), processHost.close()]).finally(() =>
    process.exit(0),
  );
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('SIGHUP', stop);
process.once('uncaughtException', (error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  stop();
});
process.once('unhandledRejection', (error) => {
  process.stderr.write(`${String(error)}\n`);
  stop();
});
await host.listen();
await processHost.listen();
process.stdout.write(`Runtime host listening on ${socketPath}\n`);
process.stdout.write(
  `Background process host listening on ${processSocketPath}\n`,
);
