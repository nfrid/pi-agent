import { defaultProcessHostSocketPath } from '@pi-agent/background-jobs';
import { BackgroundJobHostService } from './background-job-host.js';

const socketPath = defaultProcessHostSocketPath();
const stateDir =
  process.env.PI_DASHBOARD_STATE_DIR ||
  `${process.env.HOME || process.cwd()}/.pi/agent/dashboard`;
const host = new BackgroundJobHostService(
  socketPath,
  `${stateDir}/background-jobs.sqlite`,
);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void host.close().finally(() => process.exit(0));
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
try {
  await host.listen();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  await host.close();
  process.exit(1);
}
process.stdout.write(`Background process host listening on ${socketPath}\n`);
