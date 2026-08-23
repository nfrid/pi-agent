import { mkdtemp, rm } from 'node:fs/promises';
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
