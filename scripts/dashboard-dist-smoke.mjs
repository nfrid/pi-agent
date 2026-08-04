import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-dist-'));
const socketPath = path.join(stateDir, 'bridge.sock');
const child = spawn(
  process.execPath,
  [path.join(root, 'apps/dashboard-server/dist/index.js')],
  {
    cwd: root,
    env: {
      ...process.env,
      PI_DASHBOARD_HOST: '127.0.0.1',
      PI_DASHBOARD_PORT: '0',
      PI_DASHBOARD_STATE_DIR: stateDir,
      PI_DASHBOARD_SOCKET: socketPath,
      PI_DASHBOARD_AUTH_TOKEN: 'dashboard-dist-smoke-token',
      PI_DASHBOARD_ORIGINS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let output = '';
const append = (chunk) => {
  output += chunk.toString();
};
child.stdout.on('data', append);
child.stderr.on('data', append);

const fail = (message) => {
  throw new Error(`${message}\n${output}`);
};

try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for dist/index.js to listen.')),
      10_000,
    );
    const onOutput = () => {
      const match =
        /Pi Dashboard listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.off('data', onOutput);
      child.stderr.off('data', onOutput);
      resolve(Number(match[1]));
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited before listening (${code ?? signal})`));
    });
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  if (response.status !== 200) fail(`health returned HTTP ${response.status}`);
  const health = await response.json();
  if (health?.ok !== true) fail('health response was not { ok: true }');
  child.kill('SIGTERM');
  const [code, signal] = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out waiting for clean daemon shutdown.'));
    }, 10_000);
    child.once('exit', (exitCode, exitSignal) => {
      clearTimeout(timer);
      resolve([exitCode, exitSignal]);
    });
  });
  if (code !== 0) fail(`daemon did not shut down cleanly (${code ?? signal})`);
  process.stdout.write(`dashboard dist smoke passed on port ${port}\n`);
} finally {
  if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
  await rm(stateDir, { recursive: true, force: true });
}
