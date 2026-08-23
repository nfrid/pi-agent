import { mkdtemp, rm, stat } from 'node:fs/promises';
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
      store.appendEvent(firstId, 'stderr', 'second');
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
        first.events.map(({ stream, text }) => ({ stream, text })),
      ).toEqual([
        { stream: 'stdout', text: 'first' },
        { stream: 'stderr', text: 'second' },
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
