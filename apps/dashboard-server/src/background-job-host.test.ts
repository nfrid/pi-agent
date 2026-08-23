import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackgroundJobsClient } from '@pi-agent/background-jobs';
import { afterEach, describe, expect, it } from 'vitest';
import { BackgroundJobHostService } from './background-job-host.js';
import {
  BackgroundJobStore,
  HOST_RESTART_ERROR,
} from './background-job-store.js';

const hosts: BackgroundJobHostService[] = [];
const id = '123e4567-e89b-12d3-a456-426614174010';

async function waitUntil(
  check: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for process.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createHost(root: string): Promise<BackgroundJobHostService> {
  const host = new BackgroundJobHostService(
    path.join(root, 'jobs.sock'),
    path.join(root, 'jobs.sqlite'),
  );
  await host.listen();
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

describe('background process host', () => {
  it('watchdog kills a descendant after abrupt process-host death', async () => {
    execFileSync('pnpm', ['--filter', '@pi-agent/background-jobs', 'build'], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    const root = await mkdtemp(path.join(os.tmpdir(), 'background-abrupt-'));
    const socket = path.join(root, 'jobs.sock');
    const processHost = spawn(
      'pnpm',
      ['--filter', '@pi-dashboard/server', 'process-host'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PI_PROCESS_HOST_SOCKET: socket,
          PI_DASHBOARD_STATE_DIR: root,
        },
        stdio: 'ignore',
      },
    );
    try {
      const client = new BackgroundJobsClient(socket, 'abrupt');
      // Wait for the subprocess-owned socket explicitly.
      for (;;) {
        try {
          await client.list();
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      const started = await client.start({
        id,
        command: `node -e ${JSON.stringify("const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','process.on(\\\"SIGTERM\\\",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid);")}`,
        title: 'abrupt',
        cwd: process.cwd(),
      });
      let descendant = 0;
      await waitUntil(() => {
        try {
          const output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
            encoding: 'utf8',
          });
          const matches = output
            .split('\n')
            .filter((line) => line.includes('process-host-main'));
          if (matches.length)
            descendant = Number(matches.at(-1)?.trim().split(/\s+/u)[0]);
          return Boolean(descendant);
        } catch {
          return false;
        }
      });
      let pid = 0;
      for (;;) {
        const job = await client.inspect(started.id);
        pid = Number(job?.stdout.text.trim());
        if (pid > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(pid).toBeGreaterThan(0);
      process.kill(descendant, 'SIGKILL');
      await waitUntil(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
    } finally {
      try {
        processHost.kill('SIGKILL');
      } catch {
        /* exited */
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not mutate the database on duplicate socket startup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'background-duplicate-'));
    try {
      const host = await createHost(root);
      const client = new BackgroundJobsClient(host.socketPath, 'session');
      const input = {
        id,
        command: 'sleep 60',
        title: 'job',
        cwd: process.cwd(),
      };
      await client.start(input);
      const duplicate = new BackgroundJobHostService(
        host.socketPath,
        path.join(root, 'jobs.sqlite'),
      );
      await expect(duplicate.listen()).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
      expect((await client.inspect(id))?.status).toBe('running');
    } finally {
      await Promise.all(hosts.splice(0).map((host) => host.close()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it('kills TERM-ignoring descendants after the shell leader closes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'background-tree-'));
    try {
      const host = await createHost(root);
      const client = new BackgroundJobsClient(host.socketPath, 'session');
      await client.start({
        id,
        command:
          'trap "" TERM; (trap "" TERM; while :; do sleep 1; done) & wait',
        title: 'tree',
        cwd: process.cwd(),
      });
      const [stopped] = await client.stop([id]);
      expect(stopped?.status).toBe('killed');
    } finally {
      await Promise.all(hosts.splice(0).map((host) => host.close()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it('closes with terminal state and owner-only SQLite files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'background-close-'));
    try {
      const host = await createHost(root);
      const client = new BackgroundJobsClient(host.socketPath, 'session');
      await client.start({
        id,
        command: 'sleep 60',
        title: 'job',
        cwd: process.cwd(),
      });
      await host.close();
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(root, 'jobs.sqlite'))).mode & 0o777).toBe(
        0o600,
      );
      const reopened = await createHost(root);
      expect(
        (
          await new BackgroundJobsClient(
            reopened.socketPath,
            'session',
          ).inspect(id)
        )?.status,
      ).toBe('killed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('captures both streams, exit status, and idempotent starts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'background-host-'));
    try {
      const host = await createHost(root);
      const client = new BackgroundJobsClient(host.socketPath, 'session');
      const input = {
        id,
        command: 'printf out; printf err >&2; exit 3',
        title: 'job',
        cwd: process.cwd(),
      };
      const [first, second] = await Promise.all([
        client.start(input),
        client.start(input),
      ]);
      expect(second.id).toBe(first.id);
      const settled = await client.wait(id, 2_000);
      expect(settled).toMatchObject({ status: 'failed', exitCode: 3 });
      expect(settled.stdout.text).toBe('out');
      expect(settled.stderr.text).toBe('err');
      await expect(
        client.start({ ...input, title: 'different' }),
      ).rejects.toMatchObject({ code: 'job-conflict' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prunes settled rows while retaining the latest 32 per owner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'background-prune-'));
    const database = path.join(root, 'jobs.sqlite');
    try {
      const store = new BackgroundJobStore(database);
      for (let index = 0; index < 34; index++) {
        const jobId = `${id.slice(0, -2)}${String(index).padStart(2, '0')}`;
        const row = store.create(
          {
            id: jobId,
            ownerSession: 'session',
            command: 'true',
            title: 'job',
            cwd: '.',
          },
          String(index),
          index,
        );
        store.settle(
          jobId,
          'done',
          { exitCode: 0 },
          row.stdout,
          row.stderr,
          index + 100,
        );
      }
      expect(store.list('session')).toHaveLength(32);
      store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reconciles active rows as lost on reopen without adopting the pid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'background-store-'));
    const database = path.join(root, 'jobs.sqlite');
    try {
      const first = new BackgroundJobStore(database);
      first.create(
        {
          id,
          ownerSession: 'session',
          command: 'sleep 1',
          title: 'job',
          cwd: '.',
        },
        'fingerprint',
      );
      first.setPid(id, 99999);
      first.close();
      const reopened = new BackgroundJobStore(database);
      const row = reopened.get('session', id);
      expect(row).toMatchObject({ status: 'failed', pid: undefined });
      expect(row?.error).toContain(HOST_RESTART_ERROR);
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
