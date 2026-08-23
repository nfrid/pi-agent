import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'all';
if (
  !['all', 'daemon', 'web', 'serve', 'runtime-host', 'process-host'].includes(
    mode,
  )
) {
  process.stderr.write(
    'Usage: node scripts/dashboard-dev.mjs [all|daemon|web|serve|runtime-host|process-host]\n',
  );
  process.exit(2);
}

const envFile = path.resolve(
  root,
  process.env.PI_DASHBOARD_ENV_FILE ?? '.env.dashboard',
);

function parseEnv(file) {
  if (!existsSync(file)) return {};
  const values = {};
  for (const sourceLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid environment line: ${sourceLine}`);
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

const fileEnv = parseEnv(envFile);
const env = { ...fileEnv, ...process.env };
env.PI_DASHBOARD_HOST ??= '127.0.0.1';
env.PI_DASHBOARD_PORT ??= '4173';
env.PI_DASHBOARD_WEB_PORT ??= '4174';
env.PI_DASHBOARD_AUTH_TOKEN ??= 'change-me';
env.PI_DASHBOARD_ORIGINS ??= `http://127.0.0.1:${env.PI_DASHBOARD_WEB_PORT}`;
env.VITE_DASHBOARD_URL ??= `http://127.0.0.1:${env.PI_DASHBOARD_PORT}`;

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const children = new Set();
let stopping = false;

function run(name, args, independent = false) {
  const child = spawn(pnpm, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    // Give each pnpm wrapper and its grandchildren one process group so a
    // forced launchd restart cannot orphan the actual daemon or preview server.
    detached: process.platform !== 'win32',
  });
  children.add(child);
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (stopping) return;
    const exitCode = code ?? (signal ? 1 : 0);
    if (independent && (mode === 'runtime-host' || mode === 'process-host')) {
      process.exitCode = exitCode;
      return;
    }
    if (mode === 'all' || mode === 'daemon' || mode === 'serve') stop(exitCode);
    else process.exitCode = exitCode;
  });
  child.once('error', (error) => {
    process.stderr.write(`[dashboard:${name}] ${error.message}\n`);
    if (independent && (mode === 'runtime-host' || mode === 'process-host'))
      process.exitCode = 1;
    else stop(1);
  });
}

function signalChildTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  child.kill(signal);
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) signalChildTree(child, 'SIGTERM');
  setTimeout(() => {
    for (const child of children) signalChildTree(child, 'SIGKILL');
  }, 2_000).unref();
  process.exitCode = exitCode;
}

function endpointInUse(target) {
  return new Promise((resolve) => {
    const socket = net.connect(target);
    const finish = (used) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(used);
    };
    socket.setTimeout(300);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function main() {
  if (!existsSync(envFile))
    process.stderr.write(
      `Dashboard environment file not found at ${envFile}; using safe local defaults. Copy .env.dashboard.example to .env.dashboard to customize it.\n`,
    );

  if (mode === 'all' || mode === 'daemon' || mode === 'serve') {
    const host = env.PI_DASHBOARD_HOST;
    const port = Number(env.PI_DASHBOARD_PORT);
    if (await endpointInUse({ host, port })) {
      process.stderr.write(
        `Dashboard API ${host}:${port} is already in use. Refusing to start a second daemon because it would steal dashboard/bridge.sock and make live sessions look dormant.\nUse \`pnpm dashboard:web\` for UI HMR against the running production API.\n`,
      );
      process.exit(2);
    }
  }

  if (mode === 'all' || mode === 'daemon')
    run('daemon', ['--filter', '@pi-dashboard/server', 'dev']);
  if (
    mode === 'all' ||
    mode === 'daemon' ||
    mode === 'serve' ||
    mode === 'runtime-host' ||
    mode === 'process-host'
  ) {
    const runtimeHostSocket =
      env.PI_DASHBOARD_RUNTIME_HOST_SOCKET ??
      path.join(
        env.PI_DASHBOARD_STATE_DIR ??
          path.join(env.HOME ?? process.cwd(), '.pi', 'agent', 'dashboard'),
        'runtime-host.sock',
      );
    env.PI_PROCESS_HOST_SOCKET ??= path.join(
      env.PI_DASHBOARD_STATE_DIR ??
        path.join(env.HOME ?? process.cwd(), '.pi', 'agent', 'dashboard'),
      'background-jobs.sock',
    );
    const startsRuntime = mode !== 'process-host';
    const startsProcess = mode !== 'runtime-host' && mode !== 'serve';
    if (startsRuntime) {
      if (
        mode !== 'runtime-host' &&
        (await endpointInUse({ path: runtimeHostSocket }))
      )
        process.stderr.write(`Reusing runtime host at ${runtimeHostSocket}.\n`);
      else
        run(
          'runtime-host',
          ['--filter', '@pi-dashboard/server', 'runtime-host'],
          true,
        );
    }
    if (startsProcess) {
      if (await endpointInUse({ path: env.PI_PROCESS_HOST_SOCKET }))
        process.stderr.write(
          `Reusing process host at ${env.PI_PROCESS_HOST_SOCKET}.\n`,
        );
      else
        run(
          'process-host',
          ['--filter', '@pi-dashboard/server', 'process-host'],
          true,
        );
    }
  }
  if (mode === 'all' || mode === 'web')
    run('web', ['--filter', '@pi-dashboard/web', 'dev']);
  if (mode === 'serve') {
    run('daemon', ['--filter', '@pi-dashboard/server', 'start']);
    run('web', ['--filter', '@pi-dashboard/web', 'preview']);
  }

  process.once('SIGINT', () => stop(0));
  process.once('SIGTERM', () => stop(0));
}

await main();
