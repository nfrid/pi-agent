import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BackgroundJobsClient,
  type BackgroundWatchInput,
} from '@pi-agent/background-jobs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundJobHostService } from './background-job-host.js';

let root: string;
let host: BackgroundJobHostService;
let client: BackgroundJobsClient;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'background-watch-host-'));
  host = new BackgroundJobHostService(path.join(root, 'jobs.sock'));
  await host.listen();
  client = new BackgroundJobsClient(host.socketPath, 'owner');
});
afterEach(async () => {
  await host.close();
  await rm(root, { recursive: true, force: true });
});
function start(script: string, watch?: readonly BackgroundWatchInput[]) {
  return client.start({
    id: randomUUID(),
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
    title: 'watch test',
    cwd: root,
    ...(watch ? { watch } : {}),
  });
}
const alive = 'setInterval(() => {}, 1000);';

describe('durable host output watches', () => {
  it('captures immediate output without a newline and retains one-shot outcomes across clients', async () => {
    const job = await start(`process.stdout.write('ready');${alive}`, [
      { contains: 'ready' },
    ]);
    await vi.waitFor(async () =>
      expect((await client.inspect(job.id))?.watches?.[0]?.status).toBe(
        'matched',
      ),
    );
    const reconnect = new BackgroundJobsClient(host.socketPath, 'owner');
    const snapshot = await reconnect.inspect(job.id);
    const watch = snapshot?.watches?.[0];
    expect(snapshot?.status).toBe('running');
    expect(watch).toMatchObject({
      status: 'matched',
      excerpt: 'ready',
      delivered: false,
    });
    await reconnect.acknowledgeWatches(job.id, [watch?.id as string]);
    expect((await client.inspect(job.id))?.watches?.[0]).toMatchObject({
      ...watch,
      delivered: true,
    });
  });

  it('matches across chunks but never joins stdout and stderr', async () => {
    const job = await start(
      `process.stdout.write('out');process.stderr.write('ERR');setTimeout(() => process.stdout.write('ready'), 30);${alive}`,
      [
        { contains: 'outready', stream: 'stdout' },
        { contains: 'outready', stream: 'stderr' },
        { contains: 'outERR' },
      ],
    );
    await vi.waitFor(async () =>
      expect((await client.inspect(job.id))?.watches?.[0]?.status).toBe(
        'matched',
      ),
    );
    expect(
      (await client.inspect(job.id))?.watches?.map((watch) => watch.status),
    ).toEqual(['matched', 'pending', 'pending']);
  });

  it('does not combine a pre-registration suffix with future output', async () => {
    const job = await start(
      `const fs=require('node:fs');process.stdout.write('rea');let step=0;setInterval(() => {if(step===0 && fs.existsSync('suffix')){process.stdout.write('dy');step++;}if(step===1 && fs.existsSync('full')){process.stdout.write('ready');step++;}},10);`,
    );
    await vi.waitFor(async () =>
      expect((await client.inspect(job.id))?.stdout.text).toBe('rea'),
    );
    await client.watch(job.id, [{ contains: 'ready' }]);
    await writeFile(path.join(root, 'suffix'), '');
    await vi.waitFor(async () =>
      expect((await client.inspect(job.id))?.stdout.text).toBe('ready'),
    );
    expect((await client.inspect(job.id))?.watches?.[0]?.status).toBe(
      'pending',
    );
    await writeFile(path.join(root, 'full'), '');
    await vi.waitFor(async () =>
      expect((await client.inspect(job.id))?.watches?.[0]?.status).toBe(
        'matched',
      ),
    );
  });

  it('expires a watch without stopping the job or requiring a connected client', async () => {
    const job = await start(alive, [{ contains: 'never', timeoutMs: 20 }]);
    await vi.waitFor(async () =>
      expect((await client.inspect(job.id))?.watches?.[0]?.status).toBe(
        'timed_out',
      ),
    );
    const snapshot = await client.inspect(job.id);
    expect(snapshot?.status).toBe('running');
    expect(snapshot?.watches?.[0]?.delivered).toBe(false);
    const stopped = await client.stop([job.id]);
    expect(stopped[0].watches?.[0]?.status).toBe('timed_out');
  });

  it('removes watches without stopping jobs and enforces ownership', async () => {
    const job = await start(alive, [{ contains: 'never' }]);
    const watchId = job.watches?.[0]?.id as string;
    const other = new BackgroundJobsClient(host.socketPath, 'other');
    await expect(other.watch(job.id, [{ contains: 'x' }])).rejects.toThrow(
      'Unknown',
    );
    await expect(other.unwatch(job.id, [watchId])).rejects.toThrow('Unknown');
    await expect(other.acknowledgeWatches(job.id, [watchId])).rejects.toThrow(
      'Unknown',
    );
    await client.acknowledgeWatches(job.id, [watchId]);
    expect((await client.inspect(job.id))?.watches?.[0]?.delivered).toBe(false);
    expect(await client.unwatch(job.id, [watchId])).toMatchObject({
      status: 'running',
      watches: [],
    });
  });

  it('ends unmatched watches on process exit and bounds retained watch count', async () => {
    const job = await start('process.exit(0)', [{ contains: 'never' }]);
    const ended = await client.wait(job.id, 1000);
    expect(ended).toMatchObject({
      status: 'done',
      watches: [{ status: 'ended' }],
    });
    await expect(client.watch(job.id, [{ contains: 'late' }])).rejects.toThrow(
      'running',
    );
    const running = await start(
      alive,
      Array.from({ length: 8 }, () => ({ contains: 'never' })),
    );
    await expect(
      client.watch(running.id, [{ contains: 'extra' }]),
    ).rejects.toThrow('At most 8');
  });
});
