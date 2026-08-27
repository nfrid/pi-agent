import { mkdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../repositories/migrations.js';
import { SqliteSessionUsageRepository } from '../repositories/sqlite-session-usage-repository.js';
import {
  SessionUsageService,
  sessionUsageEvent,
} from './session-usage-service.js';

const roots: string[] = [];
let db: DatabaseSync | undefined;

afterEach(async () => {
  db?.close();
  db = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

function assistant(id: string, timestamp: string) {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp,
    message: {
      role: 'assistant',
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      usage: {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        totalTokens: 100,
        cost: { total: 1.25 },
      },
    },
  };
}

async function fixture() {
  const root = path.join(
    tmpdir(),
    `dashboard-session-usage-${Date.now()}-${Math.random()}`,
  );
  const active = path.join(root, 'sessions');
  const archive = path.join(root, 'session-archive', 'sessions');
  await mkdir(active, { recursive: true });
  await mkdir(archive, { recursive: true });
  roots.push(root);
  db = new DatabaseSync(':memory:');
  runMigrations(db);
  const repository = new SqliteSessionUsageRepository(db);
  return { root, active, archive, repository };
}

describe('session usage indexing', () => {
  it('uses the provider response model when it differs from the requested model', () => {
    const entry = {
      ...assistant('entry-1', '2026-08-20T10:00:00Z'),
      message: {
        ...assistant('entry-1', '2026-08-20T10:00:00Z').message,
        responseModel: 'gpt-5.6-sol-actual',
      },
    };
    expect(sessionUsageEvent(entry)).toMatchObject({
      modelId: 'gpt-5.6-sol-actual',
      label: 'gpt-5.6-sol-actual',
    });
  });

  it('extracts exact model tokens and recorded API-equivalent cost', () => {
    expect(
      sessionUsageEvent(assistant('entry-1', '2026-08-20T10:00:00Z')),
    ).toMatchObject({
      provider: 'openai-codex',
      modelId: 'gpt-5.6-sol',
      label: 'gpt-5.6-sol',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      totalTokens: 100,
      costUsd: 1.25,
    });
  });

  it('keeps unattributed compaction cost under an honest synthetic series', () => {
    expect(
      sessionUsageEvent({
        ...assistant('compact-1', '2026-08-20T11:00:00Z'),
        type: 'compaction',
        usage: assistant('unused', '2026-08-20T11:00:00Z').message.usage,
      }),
    ).toMatchObject({
      provider: 'pi',
      modelId: 'compaction-summaries',
      label: 'Compaction summaries',
    });
  });

  it('backfills active and archived files without double counting moved sessions', async () => {
    const { active, archive, repository } = await fixture();
    const event = assistant('entry-1', '2026-08-20T10:00:00Z');
    const body = `${JSON.stringify({ type: 'session', id: 'session-1' })}\n${JSON.stringify(event)}\n`;
    await writeFile(path.join(active, 'active.jsonl'), body);
    await writeFile(path.join(archive, 'archived-copy.jsonl'), body);
    const now = Date.parse('2026-08-21T00:00:00Z');
    const service = new SessionUsageService(
      repository,
      [active, archive],
      () => now,
    );

    const series = await service.read(now - 24 * 60 * 60_000, now, 60 * 60_000);
    expect(series).toHaveLength(1);
    expect(series[0]?.points).toEqual([
      expect.objectContaining({ calls: 1, costUsd: 1.25, totalTokens: 100 }),
    ]);
    expect(
      db?.prepare('SELECT COUNT(*) AS count FROM session_usage_event').get(),
    ).toEqual({ count: 1 });
    expect(
      db?.prepare('SELECT COUNT(*) AS count FROM session_usage_source').get(),
    ).toEqual({ count: 2 });
  });

  it('distinguishes identical entry ids from different durable sessions', async () => {
    const { active, repository } = await fixture();
    const event = JSON.stringify(assistant('entry-1', '2026-08-20T10:00:00Z'));
    await writeFile(
      path.join(active, 'first.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'session-1' })}\n${event}\n`,
    );
    await writeFile(
      path.join(active, 'second.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'session-2' })}\n${event}\n`,
    );
    const now = Date.parse('2026-08-21T00:00:00Z');

    const series = await new SessionUsageService(
      repository,
      [active],
      () => now,
    ).read(now - 24 * 60 * 60_000, now, 60 * 60_000);

    expect(series[0]?.points[0]).toMatchObject({ calls: 2, costUsd: 2.5 });
  });

  it('rescans a same-size rewrite even when its mtime is restored', async () => {
    const { active, repository } = await fixture();
    const file = path.join(active, 'active.jsonl');
    const fixedTime = new Date('2026-08-20T12:00:00Z');
    await writeFile(
      file,
      `${JSON.stringify(assistant('entry-1', '2026-08-20T10:00:00Z'))}\n`,
    );
    await utimes(file, fixedTime, fixedTime);
    const before = await stat(file);
    const now = Date.parse('2026-08-21T00:00:00Z');
    await new SessionUsageService(repository, [active], () => now).read(
      now - 24 * 60 * 60_000,
      now,
      60 * 60_000,
    );
    const firstFingerprint = repository.source(file)?.fingerprint;

    const revised = assistant('entry-1', '2026-08-20T10:00:00Z');
    revised.message.usage.cost.total = 2.25;
    await writeFile(file, `${JSON.stringify(revised)}\n`);
    await utimes(file, fixedTime, fixedTime);
    const after = await stat(file);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    await new SessionUsageService(repository, [active], () => now + 1).read(
      now - 24 * 60 * 60_000,
      now,
      60 * 60_000,
    );

    expect(repository.source(file)?.fingerprint).not.toBe(firstFingerprint);
    expect(
      db?.prepare('SELECT COUNT(*) AS count FROM session_usage_event').get(),
    ).toEqual({ count: 1 });
    expect(
      db
        ?.prepare('SELECT SUM(cost_usd) AS cost FROM session_usage_event')
        .get(),
    ).toEqual({ cost: 2.25 });
  });

  it('reconciles a moved source before replacing its rewritten events', async () => {
    const { active, repository } = await fixture();
    const original = path.join(active, 'original.jsonl');
    const moved = path.join(active, 'moved.jsonl');
    const header = `${JSON.stringify({ type: 'session', id: 'session-1' })}\n`;
    await writeFile(
      original,
      `${header}${JSON.stringify(assistant('entry-1', '2026-08-20T10:00:00Z'))}\n`,
    );
    const now = Date.parse('2026-08-21T00:00:00Z');
    await new SessionUsageService(repository, [active], () => now).read(
      now - 24 * 60 * 60_000,
      now,
      60 * 60_000,
    );

    await rename(original, moved);
    await new SessionUsageService(repository, [active], () => now + 1).read(
      now - 24 * 60 * 60_000,
      now,
      60 * 60_000,
    );
    const revised = assistant('entry-1', '2026-08-20T10:00:00Z');
    revised.message.usage.cost.total = 2.25;
    await writeFile(moved, `${header}${JSON.stringify(revised)}\n`);
    await new SessionUsageService(repository, [active], () => now + 2).read(
      now - 24 * 60 * 60_000,
      now,
      60 * 60_000,
    );

    expect(
      db?.prepare('SELECT COUNT(*) AS count FROM session_usage_source').get(),
    ).toEqual({ count: 1 });
    expect(
      db?.prepare('SELECT COUNT(*) AS count FROM session_usage_event').get(),
    ).toEqual({ count: 1 });
    expect(
      db
        ?.prepare('SELECT SUM(cost_usd) AS cost FROM session_usage_event')
        .get(),
    ).toEqual({ cost: 2.25 });
  });

  it('retries a root that appears after an incomplete scan', async () => {
    const { root, repository } = await fixture();
    const delayed = path.join(root, 'delayed-sessions');
    const now = Date.parse('2026-08-21T00:00:00Z');
    const service = new SessionUsageService(repository, [delayed], () => now);
    await expect(
      service.read(now - 24 * 60 * 60_000, now, 60 * 60_000),
    ).resolves.toEqual([]);

    await mkdir(delayed);
    await writeFile(
      path.join(delayed, 'late.jsonl'),
      `${JSON.stringify(assistant('entry-1', '2026-08-20T10:00:00Z'))}\n`,
    );
    const series = await service.read(now - 24 * 60 * 60_000, now, 60 * 60_000);
    expect(series[0]?.points[0]).toMatchObject({ calls: 1, costUsd: 1.25 });
  });

  it('keeps append transactions inside an existing database transaction', async () => {
    const { repository } = await fixture();
    const event = sessionUsageEvent(
      assistant('entry-1', '2026-08-20T10:00:00Z'),
      'session-1',
    );
    if (!event) throw new Error('Expected a usage event.');
    db?.exec('BEGIN');
    repository.appendFile(
      {
        path: '/sessions/test.jsonl',
        size: 1,
        mtimeMs: 1,
        ctimeMs: 1,
        fingerprint: 'a'.repeat(64),
      },
      [event],
      Date.parse('2026-08-21T00:00:00Z'),
    );
    db?.exec('ROLLBACK');

    expect(
      db?.prepare('SELECT COUNT(*) AS count FROM session_usage_event').get(),
    ).toEqual({ count: 0 });
  });

  it('skips unchanged sources on later service instances', async () => {
    const { active, repository } = await fixture();
    const file = path.join(active, 'active.jsonl');
    await writeFile(
      file,
      `${JSON.stringify(assistant('entry-1', '2026-08-20T10:00:00Z'))}\n`,
    );
    const now = Date.parse('2026-08-21T00:00:00Z');
    await new SessionUsageService(repository, [active], () => now).read(
      now - 24 * 60 * 60_000,
      now,
      60 * 60_000,
    );
    await new SessionUsageService(repository, [active], () => now + 1).read(
      now - 24 * 60 * 60_000,
      now,
      60 * 60_000,
    );
    expect(
      db?.prepare('SELECT COUNT(*) AS count FROM session_usage_event').get(),
    ).toEqual({ count: 1 });
  });
});
