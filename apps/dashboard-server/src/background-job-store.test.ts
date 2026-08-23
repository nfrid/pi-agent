import { chmodSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BACKGROUND_JOBS_MAX_EVENT_BYTES,
  BACKGROUND_JOBS_MAX_EVENT_LINE_BYTES,
} from '@pi-agent/background-jobs';
import { describe, expect, it } from 'vitest';
import {
  BackgroundJobStore,
  backgroundJobEventsPath,
} from './background-job-store.js';

const firstId = '123e4567-e89b-12d3-a456-426614174021';
const secondId = '123e4567-e89b-12d3-a456-426614174022';

function input(id: string) {
  return {
    id,
    ownerSession: 'owner',
    command: 'delegate',
    title: 'delegate',
    cwd: '.',
    events: true,
  } as const;
}

describe('background job event store', () => {
  it('replays durable ordered events with a bounded response', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'background-event-store-'),
    );
    const store = new BackgroundJobStore(path.join(root, 'jobs.sqlite'));
    try {
      const row = store.create(input(firstId), 'fingerprint');
      store.appendEvent(firstId, 'stdout', 'first');
      store.appendEvent(firstId, 'stderr', 'second', true);
      store.settle(
        firstId,
        'killed',
        { error: 'timed out', timedOut: true },
        row.stdout,
        row.stderr,
      );
      expect(store.get('owner', firstId)).toMatchObject({ timedOut: true });
      const first = store.readEvents('owner', firstId, 0);
      expect(
        first.events.map(({ stream, text, truncated }) => ({
          stream,
          text,
          truncated,
        })),
      ).toEqual([
        { stream: 'stdout', text: 'first', truncated: false },
        { stream: 'stderr', text: 'second', truncated: true },
      ]);
      expect(first.complete).toBe(true);
      expect(first.truncated).toBe(false);
      expect(
        store.readEvents('owner', firstId, first.nextOffset),
      ).toMatchObject({
        events: [],
        complete: true,
      });
      expect(
        (
          await stat(
            backgroundJobEventsPath(path.join(root, 'jobs.sqlite'), firstId),
          )
        ).mode & 0o777,
      ).toBe(0o600);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clips control-heavy records so the first page always advances', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'background-event-control-'),
    );
    const database = path.join(root, 'jobs.sqlite');
    const store = new BackgroundJobStore(database);
    try {
      const row = store.create(input(firstId), 'control');
      store.appendEvent(
        firstId,
        'stdout',
        '\0'.repeat(BACKGROUND_JOBS_MAX_EVENT_LINE_BYTES),
      );
      store.settle(firstId, 'done', { exitCode: 0 }, row.stdout, row.stderr);
      const page = store.readEvents('owner', firstId, 0);
      expect(page.events[0]?.truncated).toBe(true);
      expect(page.nextOffset).toBeGreaterThan(0);
      expect(page.complete).toBe(true);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('migrates legacy launch fingerprints without retaining launch plaintext', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'background-fingerprint-'),
    );
    const database = path.join(root, 'jobs.sqlite');
    const launch = {
      ...input(firstId),
      command: 'delegate display',
      argv: ['/usr/bin/node', 'secret prompt'],
      env: { SECRET_ENV: 'secret value' },
      timeoutMs: 100,
      events: true,
    } as const;
    const first = new BackgroundJobStore(database);
    try {
      first.create(launch, 'ignored');
      first.db.exec('ALTER TABLE background_jobs ADD COLUMN env_json TEXT');
      first.db
        .prepare(
          'UPDATE background_jobs SET fingerprint = ?, env_json = ? WHERE id = ?',
        )
        .run(
          JSON.stringify({
            command: launch.command,
            title: launch.title,
            cwd: launch.cwd,
            argv: launch.argv,
            env: launch.env,
            timeoutMs: launch.timeoutMs,
            events: launch.events,
          }),
          JSON.stringify({ SECRET_ENV: 'secret value' }),
          firstId,
        );
    } finally {
      first.close();
    }
    const reopened = new BackgroundJobStore(database);
    try {
      const fingerprint = reopened.getById(firstId)?.fingerprint;
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(fingerprint).not.toContain('secret');
      expect(
        reopened.db
          .prepare('PRAGMA table_info(background_jobs)')
          .all()
          .map((column) => column.name),
      ).not.toContain('env_json');
      expect(reopened.create(launch, 'different').id).toBe(firstId);
    } finally {
      reopened.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds event files and reports retained-history truncation', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'background-event-bounds-'),
    );
    const database = path.join(root, 'jobs.sqlite');
    const store = new BackgroundJobStore(database);
    try {
      const row = store.create(input(firstId), 'bounds');
      for (let index = 0; index < 80; index++)
        store.appendEvent(
          firstId,
          'stdout',
          `${index}:${'x'.repeat(BACKGROUND_JOBS_MAX_EVENT_LINE_BYTES - 16)}`,
        );
      store.settle(firstId, 'done', { exitCode: 0 }, row.stdout, row.stderr);
      const file = await stat(backgroundJobEventsPath(database, firstId));
      expect(file.size).toBeLessThanOrEqual(BACKGROUND_JOBS_MAX_EVENT_BYTES);
      const page = store.readEvents('owner', firstId, 0);
      expect(page.truncated).toBe(true);
      expect(page.complete).toBe(false);
      expect(page.nextOffset).toBeGreaterThan(0);
      store.appendEvent(firstId, 'stderr', 'tail');
      const lines = (
        await readFile(backgroundJobEventsPath(database, firstId), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { offset: number });
      expect(lines.at(-1)?.offset).toBeGreaterThan(lines.at(-2)?.offset ?? -1);
      expect(
        store.db
          .prepare('PRAGMA table_info(background_jobs)')
          .all()
          .map((column) => column.name),
      ).not.toContain('env_json');
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('repairs orphan, oversized, and permission-drifted event files on startup', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'background-event-repair-'),
    );
    const database = path.join(root, 'jobs.sqlite');
    const first = new BackgroundJobStore(database);
    const row = first.create(input(firstId), 'repair');
    first.appendEvent(firstId, 'stdout', 'known');
    first.settle(firstId, 'done', { exitCode: 0 }, row.stdout, row.stderr);
    first.close();
    const knownPath = backgroundJobEventsPath(database, firstId);
    const orphanPath = backgroundJobEventsPath(database, secondId);
    writeFileSync(
      knownPath,
      Buffer.alloc(BACKGROUND_JOBS_MAX_EVENT_BYTES + 1, 0x78),
    );
    chmodSync(knownPath, 0o644);
    writeFileSync(orphanPath, 'orphan\n', { mode: 0o644 });
    const reopened = new BackgroundJobStore(database);
    try {
      expect((await stat(knownPath)).size).toBeLessThanOrEqual(
        BACKGROUND_JOBS_MAX_EVENT_BYTES,
      );
      expect((await stat(knownPath)).mode & 0o777).toBe(0o600);
      await expect(stat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      reopened.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects corrupt non-contiguous event offsets', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'background-event-corrupt-'),
    );
    const database = path.join(root, 'jobs.sqlite');
    const first = new BackgroundJobStore(database);
    first.create(input(firstId), 'corrupt');
    first.close();
    writeFileSync(
      backgroundJobEventsPath(database, firstId),
      `${JSON.stringify({ offset: 0, stream: 'stdout', text: 'a', truncated: false })}\n${JSON.stringify({ offset: 0, stream: 'stderr', text: 'b', truncated: false })}\n`,
      { mode: 0o600 },
    );
    const reopened = new BackgroundJobStore(database);
    try {
      expect(() => reopened.readEvents('owner', firstId, 0)).toThrow(
        /corrupt/i,
      );
    } finally {
      reopened.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resets stale event files when a pruned id is reused', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'background-event-reuse-'),
    );
    const database = path.join(root, 'jobs.sqlite');
    const store = new BackgroundJobStore(database, 0);
    try {
      const row = store.create(input(firstId), 'old');
      store.settle(firstId, 'done', { exitCode: 0 }, row.stdout, row.stderr);
      writeFileSync(backgroundJobEventsPath(database, firstId), 'stale\n', {
        mode: 0o600,
      });
      store.create(input(firstId), 'new');
      await expect(
        stat(backgroundJobEventsPath(database, firstId)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deletes event files with pruned terminal rows', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'background-event-prune-'),
    );
    const store = new BackgroundJobStore(path.join(root, 'jobs.sqlite'), 1);
    try {
      const first = store.create(input(firstId), 'first');
      store.appendEvent(firstId, 'stdout', 'old');
      store.settle(
        firstId,
        'done',
        { exitCode: 0 },
        first.stdout,
        first.stderr,
        1,
      );
      const second = store.create(input(secondId), 'second');
      store.appendEvent(secondId, 'stdout', 'new');
      store.settle(
        secondId,
        'done',
        { exitCode: 0 },
        second.stdout,
        second.stderr,
        2,
      );
      await expect(
        stat(backgroundJobEventsPath(path.join(root, 'jobs.sqlite'), firstId)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        await stat(
          backgroundJobEventsPath(path.join(root, 'jobs.sqlite'), secondId),
        ),
      ).toBeTruthy();
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
