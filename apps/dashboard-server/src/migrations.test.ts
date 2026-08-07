import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_MIGRATIONS,
  runMigrations,
} from './repositories/migrations.js';

it('applies numbered dashboard migrations idempotently', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'pi-dashboard-migrations-'),
  );
  const db = new DatabaseSync(path.join(root, 'dashboard.sqlite'));
  try {
    runMigrations(db);
    runMigrations(db);
    expect(
      db
        .prepare('SELECT version,name FROM schema_migrations ORDER BY version')
        .all(),
    ).toEqual(
      DASHBOARD_MIGRATIONS.map(({ version, name }) => ({ version, name })),
    );
    const columns = db
      .prepare('PRAGMA table_info(managed_launch)')
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'identity_token_hash',
        'launch_token_hash',
        'launch_consumed',
      ]),
    );
  } finally {
    db.close();
  }
});

describe('migration metadata', () => {
  it('uses stable ascending migration numbers', () => {
    expect(DASHBOARD_MIGRATIONS.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('upgrades a database that already has the phase-one migrations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-upgrade-'));
    const db = new DatabaseSync(path.join(root, 'dashboard.sqlite'));
    try {
      runMigrations(db, DASHBOARD_MIGRATIONS.slice(0, 3));
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='worktree_record'",
          )
          .all(),
      ).toEqual([]);
      runMigrations(db);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('project','checkout','thread','orchestration_run','worktree_record','command_receipt') ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: 'checkout' },
        { name: 'command_receipt' },
        { name: 'orchestration_run' },
        { name: 'project' },
        { name: 'thread' },
        { name: 'worktree_record' },
      ]);
      expect(
        db
          .prepare('PRAGMA table_info(thread)')
          .all()
          .map((row) => row.name),
      ).toContain('pinned_at');
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('active_runtime_per_run','orchestration_run_thread_attempt_unique','project_repository_identity_unique') ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: 'active_runtime_per_run' },
        { name: 'orchestration_run_thread_attempt_unique' },
        { name: 'project_repository_identity_unique' },
      ]);
      db.prepare(
        `INSERT INTO project (id,title,root_path,repository_identity,default_isolation,max_parallel_runs,status,created_at,updated_at)
         VALUES ('identity-one','One','/one','/shared/.git','worktree',1,'active',1,1)`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO project (id,title,root_path,repository_identity,default_isolation,max_parallel_runs,status,created_at,updated_at)
             VALUES ('identity-two','Two','/two','/shared/.git','worktree',1,'active',1,1)`,
          )
          .run(),
      ).toThrow();
      db.prepare(
        `INSERT INTO project (id,title,root_path,repository_identity,default_isolation,max_parallel_runs,status,created_at,updated_at)
         VALUES ('identity-null','Null','/null',NULL,'worktree',1,'active',1,1)`,
      ).run();
    } finally {
      db.close();
    }
  });
});
