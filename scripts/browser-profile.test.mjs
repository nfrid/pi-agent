import { spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const adapter = join(root, 'scripts/browser-profile.mjs');
let temp;
let caller;
let origin;
let server;
const owners = new Map();
const childConfigs = new Map();
const ownerSnapshots = new Map();

function run(args, cwd = caller, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [adapter, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function open(config, headed = false, foreground = false) {
  const args = [
    foreground ? '_owner' : 'open',
    '--config',
    config,
    ...(headed ? ['--headed'] : []),
  ];
  const child = spawn(process.execPath, [adapter, ...args], {
    cwd: caller,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  owners.set(config, child);
  childConfigs.set(child, config);
  await new Promise((resolveOpen, reject) => {
    let output = '';
    let ready = false;
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
      if (
        output.includes(
          foreground ? 'Persistent browser profile is open' : 'Browser opened.',
        )
      ) {
        ready = true;
        clearTimeout(timeout);
        resolveOpen();
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (!ready) reject(new Error(`Profile owner exited ${code}: ${output}`));
    });
  });
  const profile = JSON.parse(await readFile(config, 'utf8')).browser
    .userDataDir;
  const file = `${profile}.pi-owner/owner.json`;
  ownerSnapshots.set(config, { file, text: await readFile(file, 'utf8') });
  return child;
}

function configFor(name) {
  const workspace = join(temp, name, 'workspace');
  const profile = join(temp, name, 'profile');
  return mkdir(workspace, { recursive: true }).then(async () => {
    const path = join(workspace, 'cli.config.json');
    await writeFile(
      path,
      JSON.stringify({
        browser: {
          browserName: 'chromium',
          isolated: false,
          userDataDir: profile,
          launchOptions: { headless: true, channel: 'chrome' },
        },
      }),
    );
    return { path, profile, workspace };
  });
}

async function command(config, ...args) {
  const result = await run([...args, '--config', config.path]);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

async function stop(config) {
  await command(config, 'close');
  owners.delete(config.path);
}

beforeAll(async () => {
  // macOS's default temp prefix exceeds the Unix socket pathname limit.
  temp = await mkdtemp('/tmp/pi-browser-profile-');
  caller = join(temp, 'outside-config-root');
  await mkdir(caller);
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/set') {
      const profile = url.searchParams.get('profile');
      response.setHeader(
        'Set-Cookie',
        `synthetic_marker=${profile}; Max-Age=3600; Path=/; SameSite=Lax`,
      );
      response.end(
        `<!doctype html><title>Set once</title><button onclick="document.title='Clicked'">Continue</button><script>localStorage.setItem('fixture-marker', 'storage-${profile}')</script>`,
      );
    } else if (url.pathname === '/check') {
      response.end(
        `<!doctype html><title>Check only</title><body><button onclick="document.title='Clicked'">Continue</button><p id="cookie-status"></p><p id="storage-status"></p><script>document.querySelector('#cookie-status').textContent = document.cookie.includes('synthetic_marker=admin') ? 'cookie-admin' : document.cookie.includes('synthetic_marker=job') ? 'cookie-job' : 'cookie-missing'; document.querySelector('#storage-status').textContent = localStorage.getItem('fixture-marker') || 'storage-missing';</script></body>`,
      );
    } else {
      response.end('<!doctype html><title>Fixture root</title>');
    }
  });
  await new Promise((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen),
  );
  origin = `http://127.0.0.1:${server.address().port}`;
}, 10_000);

afterAll(async () => {
  for (const [path, child] of owners) {
    const result = await run(['close', '--config', path]).catch(() => ({
      code: 1,
    }));
    if (result.code !== 0) {
      const saved = ownerSnapshots.get(path);
      if (saved) {
        await writeFile(saved.file, saved.text, { mode: 0o600 });
        await run(['close', '--config', path]);
      } else child.kill('SIGTERM');
    }
  }
  for (const child of childConfigs.keys()) {
    if (child.exitCode === null && child.signalCode === null)
      await new Promise((resolveExit) => child.once('close', resolveExit));
  }
  await new Promise((resolveClose) => server?.close(resolveClose));
  await rm(temp, { recursive: true, force: true });
});

describe('persistent browser profile adapter', () => {
  it('preserves cookies and localStorage across owner restarts, isolates profiles, and scopes close', async () => {
    const admin = await configFor('admin');
    const job = await configFor('job');
    await open(admin.path);
    expect((await stat(`${admin.profile}.pi-owner`)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(`${admin.profile}.pi-owner/owner.json`)).mode & 0o777,
    ).toBe(0o600);
    await expect(run(['open', '--config', admin.path])).resolves.toMatchObject({
      code: 1,
    });
    await command(admin, 'goto', `${origin}/set?profile=admin`);
    await command(admin, 'eval', 'document.title');
    await stop(admin);

    await open(admin.path);
    await command(admin, 'goto', `${origin}/check`);
    const resumed = await command(admin, 'snapshot');
    expect(resumed).toContain('cookie-admin');
    expect(resumed).toContain('storage-admin');
    const ref = resumed.match(/button "Continue" \[ref=(e\d+)\]/)?.[1];
    expect(ref).toBeTruthy();
    await command(admin, 'click', ref);
    expect(await command(admin, 'eval', 'document.title')).toContain('Clicked');

    await open(job.path);
    await command(job, 'goto', `${origin}/set?profile=job`);
    await stop(job);
    await open(job.path);
    await command(job, 'goto', `${origin}/check`);
    const isolated = await command(job, 'snapshot');
    expect(isolated).toContain('cookie-job');
    expect(isolated).toContain('storage-job');
    expect(isolated).not.toContain('cookie-admin');
    expect(isolated).not.toContain('storage-admin');
    const stranger = await configFor('stranger');
    await stop(admin);
    await expect(
      stat(`${admin.profile}.pi-owner/owner.json`),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      stat(`${admin.profile}.pi-owner/control.sock`),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const foreignClose = await run(['close', '--config', stranger.path]);
    expect(foreignClose.code).not.toBe(0);
    expect(await command(job, 'eval', 'document.title')).toContain(
      'Check only',
    );
    await stop(job);
  }, 120_000);

  it('rejects copied owner metadata and redacts CLI failures', async () => {
    const admin = await configFor('tamper-admin');
    const job = await configFor('tamper-job');
    await open(admin.path);
    await open(job.path);
    const adminFile = `${admin.profile}.pi-owner/owner.json`;
    const jobFile = `${job.profile}.pi-owner/owner.json`;
    const adminText = await readFile(adminFile, 'utf8');
    const adminOwner = JSON.parse(adminText);
    const jobOwner = JSON.parse(await readFile(jobFile, 'utf8'));
    await writeFile(
      adminFile,
      JSON.stringify({ ...jobOwner, session: adminOwner.session }),
      { mode: 0o600 },
    );
    const copied = await run(['snapshot', '--config', admin.path]);
    expect(copied.code).not.toBe(0);
    await writeFile(
      adminFile,
      JSON.stringify({ ...adminOwner, session: jobOwner.session }),
      { mode: 0o600 },
    );
    const wrongSession = await run(['close', '--config', admin.path]);
    expect(wrongSession.code).not.toBe(0);
    expect(await command(job, 'eval', '1 + 1')).toContain('2');
    await writeFile(adminFile, adminText, { mode: 0o600 });

    const fakeCli = join(temp, 'fake-playwright-cli');
    await writeFile(
      fakeCli,
      '#!/bin/sh\nprintf "%s\\n" "$FAKE_OUTPUT"\nprintf "%s\\n" "$FAKE_OUTPUT" >&2\nexit 7\n',
    );
    await chmod(fakeCli, 0o700);
    const secretOutput = `${adminOwner.token} ${adminOwner.endpoint}`;
    const failedCli = await run(['snapshot', '--config', admin.path], caller, {
      PLAYWRIGHT_CLI: fakeCli,
      FAKE_OUTPUT: secretOutput,
    });
    expect(failedCli.code).not.toBe(0);
    for (const output of [failedCli.stdout, failedCli.stderr]) {
      expect(output.includes(adminOwner.token)).toBe(false);
      expect(output.includes(adminOwner.endpoint)).toBe(false);
    }
    expect(await command(job, 'eval', '1 + 1')).toContain('2');
    await new Promise((resolveDetach, rejectDetach) => {
      const child = spawn(
        'playwright-cli',
        [`-s=${adminOwner.session}`, 'detach'],
        {
          cwd: admin.workspace,
          stdio: 'ignore',
        },
      );
      child.once('error', rejectDetach);
      child.once('close', (code) =>
        code === 0
          ? resolveDetach()
          : rejectDetach(new Error('Owned test CLI detach failed')),
      );
    });
    await stop(admin);
    await open(admin.path);
    await stop(admin);
    await stop(job);
  }, 60_000);

  it('rejects session selectors and credential-dump commands', async () => {
    const config = await configFor('guard');
    await open(config.path);
    for (const args of [
      ['cookie-list'],
      ['-sfoo', 'snapshot'],
      ['snapshot', '-s', 'other'],
      ['snapshot', '--session-extra=other'],
      ['--unknown'],
      ['cookie-list', '--raw'],
      ['--raw', 'cookie-list'],
      ['state-save'],
      ['run-code', 'document.cookie'],
      ['eval', 'document.cookie'],
      ['goto', 'https://example.com', '-s=other'],
      ['close-all'],
    ]) {
      const result = await run([...args, '--config', config.path]);
      expect(result.code).not.toBe(0);
    }
    await stop(config);
  }, 60_000);

  it('flushes the owned profile and removes metadata on Ctrl-C', async () => {
    const config = await configFor('signal');
    const child = await open(config.path, false, true);
    await command(config, 'goto', `${origin}/set?profile=admin`);
    const closed = new Promise((resolveExit) =>
      child.once('close', resolveExit),
    );
    child.kill('SIGINT');
    expect(await closed).toBe(0);
    owners.delete(config.path);
    await expect(
      stat(`${config.profile}.pi-owner/owner.json`),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await open(config.path);
    await command(config, 'goto', `${origin}/check`);
    const resumed = await command(config, 'snapshot');
    expect(resumed).toContain('cookie-admin');
    expect(resumed).toContain('storage-admin');
    await stop(config);
  }, 60_000);

  it.skipIf(process.env.BROWSER_PROFILE_HEADED_SMOKE !== '1')(
    'supports a headed override without changing the headless config',
    async () => {
      const config = await configFor('headed');
      await open(config.path);
      expect(
        await command(
          config,
          'eval',
          "navigator.userAgent.includes('HeadlessChrome')",
        ),
      ).toContain('true');
      await stop(config);
      await open(config.path, true);
      expect(
        await command(
          config,
          'eval',
          "navigator.userAgent.includes('HeadlessChrome')",
        ),
      ).toContain('false');
      await stop(config);
    },
    60_000,
  );
});
