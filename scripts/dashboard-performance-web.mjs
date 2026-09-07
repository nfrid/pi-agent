import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildId = 'dashboard-performance-baseline';
const args = process.argv.slice(2);
const mode = args.shift() ?? 'serve';

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`Missing value for --${name}`);
  return value;
}

if (mode !== 'serve') {
  process.stderr.write(
    'Usage: node scripts/dashboard-performance-web.mjs serve [--port PORT] [--api-port PORT]\n',
  );
  process.exit(2);
}

const port = option('port', process.env.PI_DASHBOARD_PERF_WEB_PORT ?? '43274');
const apiPort = option(
  'api-port',
  process.env.PI_DASHBOARD_PERF_API_PORT ?? '43273',
);
const buildDirectory = mkdtempSync(
  path.join(tmpdir(), 'pi-dashboard-performance-build-'),
);
const env = {
  ...process.env,
  PI_DASHBOARD_BUILD_ID: buildId,
  PI_DASHBOARD_PORT: apiPort,
  PI_DASHBOARD_WEB_PORT: port,
};
const bun = process.platform === 'win32' ? 'bun.exe' : 'bun';
const webDirectory = path.join(root, 'apps/dashboard-web');

const build = spawnSync(
  bun,
  ['run', 'build', '--', '--outDir', buildDirectory],
  { cwd: webDirectory, env, stdio: 'inherit' },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const preview = spawn(
  bun,
  [
    'run',
    'preview',
    '--',
    '--host',
    '127.0.0.1',
    '--port',
    port,
    '--strictPort',
    '--outDir',
    buildDirectory,
  ],
  { cwd: webDirectory, env, stdio: 'inherit' },
);
let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  preview.kill(signal);
}
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
preview.once('exit', (code, signal) => {
  rmSync(buildDirectory, { recursive: true, force: true });
  if (!stopping) process.exitCode = code ?? (signal ? 1 : 0);
});
