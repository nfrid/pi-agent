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
        'mode',
      ]),
    );
  } finally {
    db.close();
  }
});

describe('migration metadata', () => {
  it('uses stable ascending migration numbers', () => {
    expect(DASHBOARD_MIGRATIONS.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('creates the link ledger and backfills only exact run/session joins', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys=ON');
      runMigrations(db, DASHBOARD_MIGRATIONS.slice(0, 9));
      db.exec(`
        INSERT INTO project
          (id,title,root_path,default_isolation,max_parallel_runs,status,created_at,updated_at)
        VALUES ('migration-project','Migration','/migration','main',1,'active',1,1);
        INSERT INTO checkout
          (id,project_id,kind,path,status,created_at,updated_at)
        VALUES ('migration-checkout','migration-project','main','/migration','ready',1,1);
        INSERT INTO thread
          (id,project_id,title,checkout_id,status,created_at,updated_at)
        VALUES ('exact-thread','migration-project','Exact','migration-checkout','stopped',1,1),
               ('ambiguous-thread','migration-project','Ambiguous','migration-checkout','stopped',1,1);
        INSERT INTO orchestration_run
          (id,thread_id,checkout_id,attempt,mode,runtime_provider,pi_session_id,initial_prompt,status,created_at)
        VALUES ('exact-run','exact-thread','migration-checkout',1,'write','extension-bridge','exact-session','prompt','interrupted',1),
               ('ambiguous-run','ambiguous-thread','migration-checkout',1,'write','extension-bridge','ambiguous-session','prompt','interrupted',1);
        INSERT INTO session_index (id,file,cwd,updated_at)
        VALUES ('exact-session','/sessions/exact.jsonl','/migration',10),
               ('ambiguous-session','/sessions/ambiguous.jsonl','/migration',10);
      `);
      // A second durable thread with the same session identity makes the
      // mapping ambiguous and must not get a guessed link.
      db.exec(`
        INSERT INTO thread
          (id,project_id,title,checkout_id,status,created_at,updated_at)
        VALUES ('ambiguous-thread-2','migration-project','Ambiguous 2','migration-checkout','stopped',1,1);
        INSERT INTO orchestration_run
          (id,thread_id,checkout_id,attempt,mode,runtime_provider,pi_session_id,initial_prompt,status,created_at)
        VALUES ('ambiguous-run-2','ambiguous-thread-2','migration-checkout',1,'write','extension-bridge','ambiguous-session','prompt','interrupted',1);
      `);
      runMigrations(db);
      expect(
        db
          .prepare('SELECT system_managed FROM project WHERE id=?')
          .get('project-system-session-index'),
      ).toEqual({
        system_managed: 1,
      });
      expect(
        db
          .prepare(
            'SELECT session_id,thread_id,source,source_file FROM session_thread_link',
          )
          .all(),
      ).toEqual([
        {
          session_id: 'exact-session',
          thread_id: 'exact-thread',
          source: 'migration',
          source_file: '/sessions/exact.jsonl',
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('adds writable mode to an old managed-launch table', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
        INSERT INTO schema_migrations VALUES
          (1,'base-dashboard-metadata',1),
          (2,'managed-launch-credentials',2),
          (3,'durable-orchestration-foundation',3),
          (4,'durable-worktree-records-and-project-identity',4),
          (5,'project-scoped-checkout-branches',5);
        CREATE TABLE managed_launch (
          runtime_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          tmux_session TEXT NOT NULL,
          tmux_window_id TEXT NOT NULL,
          tmux_pane_id TEXT NOT NULL,
          launched_at INTEGER NOT NULL,
          stopped_at INTEGER,
          identity_token_hash TEXT,
          launch_token_hash TEXT,
          launch_consumed INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO managed_launch
          (runtime_id,workspace_id,tmux_session,tmux_window_id,tmux_pane_id,launched_at)
          VALUES ('old-runtime','workspace','sesh','@1','%1',1);
      `);
      runMigrations(db);
      expect(db.prepare('SELECT mode FROM managed_launch').get()).toEqual({
        mode: 'write',
      });
    } finally {
      db.close();
    }
  });

  it.each([
    'worktree-owner-projection',
    'runtime-command-receipt-fingerprint',
  ])('reconciles the forked version-seven migration: %s', (versionSeven) => {
    const db = new DatabaseSync(':memory:');
    try {
      runMigrations(db, DASHBOARD_MIGRATIONS.slice(0, 6));
      if (versionSeven === 'worktree-owner-projection')
        db.exec(`
          CREATE TABLE worktree_owner (
            checkout_id TEXT PRIMARY KEY REFERENCES checkout(id) ON DELETE CASCADE,
            owner_kind TEXT NOT NULL CHECK (owner_kind IN ('execution','delegate-session')),
            owner_id TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
        `);
      else
        db.exec(`
          ALTER TABLE command_receipt ADD COLUMN runtime_id TEXT;
          ALTER TABLE command_receipt ADD COLUMN command_fingerprint TEXT;
        `);
      db.prepare(
        'INSERT INTO schema_migrations (version,name,applied_at) VALUES (7,?,7)',
      ).run(versionSeven);

      runMigrations(db);

      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='worktree_owner'",
          )
          .get(),
      ).toEqual({ name: 'worktree_owner' });
      expect(
        db
          .prepare('PRAGMA table_info(command_receipt)')
          .all()
          .map((row) => row.name),
      ).toEqual(expect.arrayContaining(['runtime_id', 'command_fingerprint']));
      expect(
        db.prepare('SELECT name FROM schema_migrations WHERE version=8').get(),
      ).toEqual({ name: 'reconcile-worktree-owner-and-command-receipts' });
    } finally {
      db.close();
    }
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

  it('upgrades v8 lifecycle rows, seeds one legacy snapshot, and preserves FKs', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys=ON');
      runMigrations(db, DASHBOARD_MIGRATIONS.slice(0, 8));
      db.exec(`
        INSERT INTO project (id,title,root_path,default_isolation,max_parallel_runs,status,created_at,updated_at)
        VALUES ('legacy-project','Legacy','/legacy','worktree',1,'active',1,1);
        INSERT INTO checkout (id,project_id,kind,path,status,created_at,updated_at)
        VALUES ('legacy-checkout','legacy-project','main','/legacy','ready',2,2);
        INSERT INTO thread (id,project_id,title,checkout_id,status,created_at,updated_at)
        VALUES ('legacy-thread','legacy-project','Legacy thread','legacy-checkout','archived',3,30);
        INSERT INTO orchestration_run
          (id,thread_id,checkout_id,attempt,mode,runtime_provider,initial_prompt,status,created_at,finished_at)
        VALUES ('legacy-run','legacy-thread','legacy-checkout',1,'write','extension-bridge','old prompt','settled',4,20);
      `);
      runMigrations(db);
      expect(
        db
          .prepare(
            'SELECT status,archived_at,pre_archive_status FROM thread WHERE id=?',
          )
          .get('legacy-thread'),
      ).toEqual({
        status: 'settled',
        archived_at: 30,
        pre_archive_status: 'settled',
      });
      expect(
        db
          .prepare(
            "SELECT event_type,thread_id,command_id,actor,reason FROM thread_event WHERE thread_id='legacy-thread'",
          )
          .all(),
      ).toEqual([
        {
          event_type: 'legacy.snapshot',
          thread_id: 'legacy-thread',
          command_id: null,
          actor: 'migration',
          reason: 'legacy-snapshot',
        },
      ]);
      runMigrations(db);
      expect(
        db
          .prepare(
            "SELECT count(*) AS count FROM thread_event WHERE thread_id='legacy-thread'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('rebuilds checkout from v4 without losing FK-referenced history', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-v5-'));
    const db = new DatabaseSync(path.join(root, 'dashboard.sqlite'));
    try {
      db.exec('PRAGMA foreign_keys=ON');
      runMigrations(db, DASHBOARD_MIGRATIONS.slice(0, 4));
      db.exec(`
        INSERT INTO project (id,title,root_path,default_isolation,max_parallel_runs,status,created_at,updated_at)
        VALUES ('v5-project-1','One','/one','worktree',1,'active',1,1),
               ('v5-project-2','Two','/two','worktree',1,'active',1,1);
        INSERT INTO checkout (id,project_id,kind,path,branch,base_sha,status,created_at,updated_at)
        VALUES ('v5-checkout-1','v5-project-1','worktree','/one/.worktrees/one','main','sha-one','ready',2,2),
               ('v5-checkout-2','v5-project-2','worktree','/two/.worktrees/two','other','sha-two','dirty',3,3);
        INSERT INTO thread (id,project_id,title,checkout_id,status,created_at,updated_at)
        VALUES ('v5-thread','v5-project-1','History','v5-checkout-1','settled',4,4);
        INSERT INTO orchestration_run
          (id,thread_id,checkout_id,attempt,mode,runtime_provider,initial_prompt,status,created_at)
        VALUES ('v5-run','v5-thread','v5-checkout-1',1,'write','extension-bridge','prompt','settled',5);
        INSERT INTO orchestration_runtime
          (runtime_id,pi_session_id,run_id,status,created_at,updated_at)
        VALUES ('v5-runtime','v5-session','v5-run','stopped',6,6);
        INSERT INTO worktree_record (id,checkout_id,record_json,updated_at)
        VALUES ('v5-record','v5-checkout-1','{}',7);
      `);
      runMigrations(db);
      expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({
        foreign_keys: 1,
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(
        db.prepare('SELECT id,branch FROM checkout ORDER BY id').all(),
      ).toEqual([
        { id: 'v5-checkout-1', branch: 'main' },
        { id: 'v5-checkout-2', branch: 'other' },
      ]);
      expect(db.prepare('SELECT * FROM worktree_record').all()).toHaveLength(1);
      db.prepare(
        `INSERT INTO checkout (id,project_id,kind,path,branch,status,created_at,updated_at)
         VALUES ('v5-checkout-3','v5-project-2','worktree','/two/.worktrees/main','main','ready',8,8)`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO checkout (id,project_id,kind,path,branch,status,created_at,updated_at)
             VALUES ('v5-checkout-4','v5-project-1','worktree','/one/.worktrees/main','main','ready',9,9)`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
