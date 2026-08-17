import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'all';
if (!['all', 'daemon', 'web', 'serve'].includes(mode)) {
  process.stderr.write(
    'Usage: node scripts/dashboard-dev.mjs [all|daemon|web|serve]\n',
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

function run(name, args) {
  const child = spawn(pnpm, args, { cwd: root, env, stdio: 'inherit' });
  children.add(child);
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (stopping) return;
    if (mode === 'all' || mode === 'serve') stop(code ?? (signal ? 1 : 0));
    else process.exitCode = code ?? (signal ? 1 : 0);
  });
  child.once('error', (error) => {
    process.stderr.write(`[dashboard:${name}] ${error.message}\n`);
    stop(1);
  });
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 2_000).unref();
  process.exitCode = exitCode;
}

function portInUse(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
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

  if (mode === 'all' || mode === 'daemon') {
    const host = env.PI_DASHBOARD_HOST;
    const port = Number(env.PI_DASHBOARD_PORT);
    if (await portInUse(host, port)) {
      process.stderr.write(
        `Dashboard API ${host}:${port} is already in use. Refusing to start a second daemon because it would steal dashboard/bridge.sock and make live sessions look dormant.\nUse \`pnpm dashboard:web\` for UI HMR against the running production API.\n`,
      );
      process.exit(2);
    }
  }

  if (mode === 'all' || mode === 'daemon')
    run('daemon', ['--filter', '@pi-dashboard/server', 'dev']);
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
