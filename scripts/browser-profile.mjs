#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rm } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const cli = process.env.PLAYWRIGHT_CLI ?? 'playwright-cli';
const args = process.argv.slice(2);
const command = args.shift();

function usage() {
  console.error(
    'Usage: node browser-profile.mjs open [--headed] --config PATH | close --config PATH | <playwright-cli command> --config PATH [args...]',
  );
  process.exitCode = 2;
}

function parseConfig(argv) {
  let configPath;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' || argv[i].startsWith('--config=')) {
      if (configPath) throw new Error('Pass --config once');
      configPath =
        argv[i] === '--config' ? argv[++i] : argv[i].slice('--config='.length);
      if (!configPath) throw new Error('--config requires a path');
    } else {
      rest.push(argv[i]);
    }
  }
  if (!configPath) throw new Error('--config PATH is required');
  return { configPath: resolve(configPath), rest };
}

function assertSafeCommand(argv) {
  if (!argv.length) throw new Error('A Playwright CLI command is required');
  if (argv.some((arg) => arg === '--raw' || arg === '--json'))
    throw new Error(
      'Raw and JSON CLI modes are not available through the profile adapter',
    );
  const verb = argv[0];
  if (verb.startsWith('-'))
    throw new Error('CLI options must follow a supported command');
  const supported = new Set([
    'goto',
    'type',
    'click',
    'dblclick',
    'fill',
    'drag',
    'drop',
    'hover',
    'select',
    'upload',
    'check',
    'uncheck',
    'snapshot',
    'find',
    'eval',
    'dialog-accept',
    'dialog-dismiss',
    'resize',
    'go-back',
    'go-forward',
    'reload',
    'press',
    'keydown',
    'keyup',
    'mousemove',
    'mousedown',
    'mouseup',
    'mousewheel',
    'screenshot',
    'pdf',
    'tab-list',
    'tab-new',
    'tab-close',
    'tab-select',
    'route',
    'route-list',
    'unroute',
    'network-state-set',
    'tracing-start',
    'tracing-stop',
    'video-start',
    'video-stop',
    'video-chapter',
    'video-show-actions',
    'video-hide-actions',
    'show',
    'pause-at',
    'resume',
    'step-over',
    'generate-locator',
    'highlight',
  ]);
  if (!supported.has(verb))
    throw new Error(
      `Command '${verb}' is not available through a persistent profile`,
    );
  if (
    argv.some((arg) => /^-s(?:$|.)/.test(arg) || arg.startsWith('--session'))
  ) {
    throw new Error('Session selection is managed by the profile adapter');
  }
  if (
    verb === 'eval' &&
    /cookie|localstorage|sessionstorage|indexeddb|storagestate|authorization|password|token/i.test(
      argv.slice(1).join(' '),
    )
  ) {
    throw new Error('Credential-related page evaluation is not available');
  }
}

async function loadSettings(configPath) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const browser = config.browser;
  if (
    browser?.browserName !== 'chromium' ||
    browser.isolated !== false ||
    typeof browser.userDataDir !== 'string'
  ) {
    throw new Error(
      'Config must select Chromium with isolated:false and browser.userDataDir',
    );
  }
  const profile = resolve(dirname(configPath), browser.userDataDir);
  const launchOptions = { ...(browser.launchOptions ?? {}) };
  delete launchOptions.headless;
  delete launchOptions.args;
  if (launchOptions.channel && launchOptions.channel !== 'chrome') {
    throw new Error('Only the Chrome channel is supported');
  }
  return {
    profile,
    launchOptions,
    headed: config.browser.launchOptions?.headless === false,
  };
}

function pathsFor(profile) {
  const dir = `${profile}.pi-owner`;
  return {
    dir,
    lock: join(dir, 'owner.json'),
    socket: join(dir, 'control.sock'),
  };
}

async function readOwner(paths) {
  try {
    return JSON.parse(await readFile(paths.lock, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('No open profile owner found');
    throw new Error('Profile owner metadata is unreadable');
  }
}

async function runCli(argv, cwd, secrets = [], quiet = false) {
  const child = spawn(cli, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  const safe = (value) =>
    secrets
      .filter(Boolean)
      .reduce(
        (result, secret) => result.replaceAll(secret, '[redacted]'),
        value,
      );
  if (!quiet && stdout) process.stdout.write(safe(stdout));
  if (!quiet && stderr) process.stderr.write(safe(stderr));
  if (code !== 0) throw new Error(`Playwright CLI exited with code ${code}`);
}

function sendControl(socketPath, token, action) {
  return new Promise((resolveControl, reject) => {
    const socket = connect(socketPath);
    let response = '';
    socket.setTimeout(action === 'close' ? 120_000 : 5000, () =>
      socket.destroy(new Error('Profile owner control request timed out')),
    );
    socket.setEncoding('utf8');
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ token, action })}\n`),
    );
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.length > 4096)
        socket.destroy(new Error('Invalid profile owner response'));
    });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        const result = JSON.parse(response);
        if (!result.ok)
          reject(new Error(result.error ?? 'Profile owner rejected request'));
        else resolveControl();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function closeProfile(paths, configDir) {
  const owner = await readOwner(paths);
  if (
    !owner.token ||
    owner.socket !== paths.socket ||
    !owner.endpoint ||
    !/^pi-profile-[a-f0-9]{24}$/.test(owner.session)
  )
    throw new Error('Profile owner metadata is invalid');
  await sendControl(paths.socket, owner.token, 'ping');
  await runCli(
    [`-s=${owner.session}`, 'detach'],
    configDir,
    [owner.token, owner.endpoint],
    true,
  );
  await sendControl(paths.socket, owner.token, 'close');
}

async function openProfile(settings, paths, configDir, headed) {
  await mkdir(dirname(settings.profile), { recursive: true, mode: 0o700 });
  await mkdir(settings.profile, { recursive: true, mode: 0o700 });
  await chmod(settings.profile, 0o700);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await chmod(paths.dir, 0o700);

  let lock;
  try {
    lock = await open(paths.lock, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try {
      owner = await readOwner(paths);
    } catch {
      throw new Error('Profile already has an owner or stale metadata');
    }
    try {
      process.kill(owner.pid, 0);
      throw new Error('Profile already has an owner');
    } catch (signalError) {
      if (signalError.code !== 'ESRCH') throw signalError;
    }
    await rm(paths.socket, { force: true });
    await rm(paths.lock, { force: true });
    lock = await open(paths.lock, 'wx', 0o600);
  }

  const token = randomBytes(32).toString('hex');
  const owner = {
    pid: process.pid,
    token,
    socket: paths.socket,
    session: `pi-profile-${randomBytes(12).toString('hex')}`,
  };
  const server = createServer((socket) => {
    let input = '';
    socket.setTimeout(5000, () => socket.destroy());
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      input += chunk;
      if (input.length > 4096) {
        socket.destroy();
        return;
      }
      if (!input.includes('\n')) return;
      socket.removeAllListeners('data');
      try {
        const request = JSON.parse(input.slice(0, input.indexOf('\n')));
        const supplied = Buffer.from(String(request.token ?? ''));
        const expected = Buffer.from(token);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          throw new Error('Unauthorized owner request');
        if (request.action === 'ping') {
          socket.end('{"ok":true}\n');
          return;
        }
        if (request.action !== 'close')
          throw new Error('Unknown owner request');
        socket.setTimeout(0);
        void shutdown(true).then(
          () => socket.end('{"ok":true}\n'),
          () => socket.end('{"ok":false,"error":"Owner shutdown failed"}\n'),
        );
      } catch {
        socket.end('{"ok":false,"error":"Unauthorized owner request"}\n');
      }
    });
  });
  let context;
  let attachPromise;
  let detachPromise;
  let shutdownPromise;
  let stopped = false;
  let resolveStopped;
  const stoppedPromise = new Promise((resolveStop) => {
    resolveStopped = resolveStop;
  });
  async function cleanup() {
    if (stopped) return;
    stopped = true;
    if (server.listening) server.close();
    if (lock) {
      await lock.close().catch(() => {});
      lock = undefined;
    }
    await rm(paths.socket, { force: true });
    await rm(paths.lock, { force: true });
    resolveStopped();
  }
  function detachCliSession() {
    if (!detachPromise) {
      detachPromise = (async () => {
        if (attachPromise) await attachPromise.catch(() => {});
        await runCli(
          [`-s=${owner.session}`, 'detach'],
          configDir,
          [token, owner.endpoint],
          true,
        );
      })().catch(() => {});
    }
    return detachPromise;
  }
  function shutdown(closeContext) {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        const current = context;
        if (closeContext && current) {
          await current.close();
          context = undefined;
        }
        await detachCliSession();
        await cleanup();
      })().catch((error) => {
        shutdownPromise = undefined;
        throw error;
      });
    }
    return shutdownPromise;
  }
  try {
    await lock.writeFile(JSON.stringify(owner));
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => rejectListen(error);
      server.once('error', onError);
      server.listen(paths.socket, () => {
        server.off('error', onError);
        resolveListen();
      });
    });
    await chmod(paths.socket, 0o600);
    process.once('SIGINT', () => {
      void shutdown(true).catch(() => {});
    });
    process.once('SIGTERM', () => {
      void shutdown(true).catch(() => {});
    });
    const options = {
      ...settings.launchOptions,
      headless: !headed,
      args: [
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
      ],
    };
    if (headed) options.headless = false;
    context = await chromium.launchPersistentContext(settings.profile, options);
    if (stopped) {
      await context.close();
      return;
    }
    const [port, browserPath] = (
      await readFile(join(settings.profile, 'DevToolsActivePort'), 'utf8')
    )
      .trim()
      .split('\n');
    const endpoint = `ws://127.0.0.1:${port}${browserPath}`;
    if (!port || !browserPath)
      throw new Error('Chromium did not expose its owned CDP endpoint');
    owner.endpoint = endpoint;
    await lock.truncate(0);
    await lock.write(JSON.stringify(owner), 0, 'utf8');
    await lock.close();
    lock = undefined;
    let contextClosed = false;
    let cliAttached = false;
    context.on('close', () => {
      contextClosed = true;
      if (cliAttached && !shutdownPromise) {
        context = undefined;
        void shutdown(false).catch(() => {});
      }
    });
    attachPromise = runCli(
      [`-s=${owner.session}`, 'attach', `--cdp=${owner.endpoint}`],
      configDir,
      [token, owner.endpoint],
      true,
    );
    await attachPromise;
    if (contextClosed || stopped)
      throw new Error('Browser closed during adapter startup');
    cliAttached = true;
    process.stdout.write(
      'Persistent browser profile is open. Press Ctrl-C or run the adapter close command.\n',
    );
    await stoppedPromise;
  } catch (error) {
    if (context) await context.close().catch(() => {});
    await detachCliSession();
    await cleanup();
    throw new Error(
      `Could not open persistent browser profile: ${error.message}`,
    );
  }
}

async function main() {
  if (!command) return usage();
  const parsed = parseConfig(args);
  const settings = await loadSettings(parsed.configPath);
  const paths = pathsFor(settings.profile);
  const configDir = dirname(parsed.configPath);

  if (command === 'open') {
    if (parsed.rest.some((arg) => arg !== '--headed'))
      throw new Error('Only --headed is supported with open');
    await openProfile(
      settings,
      paths,
      configDir,
      parsed.rest.includes('--headed') || settings.headed,
    );
    return;
  }
  if (command === 'close') {
    if (parsed.rest.length)
      throw new Error('close takes no additional arguments');
    await closeProfile(paths, configDir);
    return;
  }
  const cliArgs = [command, ...parsed.rest];
  assertSafeCommand(cliArgs);
  const owner = await readOwner(paths);
  if (
    !owner.endpoint ||
    !owner.token ||
    owner.socket !== paths.socket ||
    !/^pi-profile-[a-f0-9]{24}$/.test(owner.session)
  )
    throw new Error(
      'Profile owner metadata does not authenticate this profile',
    );
  await sendControl(paths.socket, owner.token, 'ping');
  await runCli([`-s=${owner.session}`, ...cliArgs], configDir, [
    owner.token,
    owner.endpoint,
  ]);
}

main().catch((error) => {
  console.error(
    error.message.replace(/ws:\/\/[^\s"']+/g, '[redacted endpoint]'),
  );
  process.exitCode = 1;
});
