import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_MIGRATIONS,
  runMigrations,
} from './repositories/migrations.js';
import { SqliteOrchestrationRepository } from './repositories/sqlite-orchestration-repository.js';

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
    const columns = db.prepare('PRAGMA table_info(managed_launch)').all();
    expect(columns.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'identity_token_hash',
        'launch_token_hash',
        'launch_consumed',
        'mode',
        'project_id',
        'checkout_id',
        'cwd',
      ]),
    );
    expect(columns.find((row) => row.name === 'workspace_id')).toMatchObject({
      notnull: 0,
    });
  } finally {
    db.close();
  }
});

describe('migration metadata', () => {
  it('uses stable ascending migration numbers', () => {
    expect(DASHBOARD_MIGRATIONS.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
  });

  it('rebuilds lifecycle events for settlement without losing history', () => {
    const db = new DatabaseSync(':memory:');
    try {
      runMigrations(db, DASHBOARD_MIGRATIONS.slice(0, 12));
      db.exec(`
        INSERT INTO project (id,title,root_path,default_isolation,max_parallel_runs,status,created_at,updated_at)
        VALUES ('settle-project','Settle','/settle','main',1,'active',1,1);
        INSERT INTO thread (id,project_id,title,status,created_at,updated_at)
        VALUES ('settle-thread','settle-project','Settle','completed',1,2);
        INSERT INTO thread_event
          (id,thread_id,event_type,command_id,actor,reason,payload_json,occurred_at)
        VALUES (41,'settle-thread','thread.archive','archive-history','user','user-command','{"status":"completed"}',3),
               (42,'settle-thread','thread.restore',NULL,'migration','legacy-snapshot','{"status":"completed"}',4);
      `);
      runMigrations(db);
      expect(
        db
          .prepare(
            'SELECT id,event_type,payload_json,occurred_at FROM thread_event ORDER BY id',
          )
          .all(),
      ).toEqual([
        {
          id: 41,
          event_type: 'thread.archive',
          payload_json: '{"status":"completed"}',
          occurred_at: 3,
        },
        {
          id: 42,
          event_type: 'thread.restore',
          payload_json: '{"status":"completed"}',
          occurred_at: 4,
        },
      ]);
      expect(
        db
          .prepare('PRAGMA table_info(thread)')
          .all()
          .map((row) => row.name),
      ).toContain('settled_at');
      for (const type of ['thread.settle', 'thread.unsettle']) {
        db.prepare(
          `INSERT INTO thread_event (thread_id,event_type,command_id,actor,reason,payload_json,occurred_at)
           VALUES (?,?,?,?,?,?,?)`,
        ).run(
          'settle-thread',
          type,
          `${type}-command`,
          'user',
          'user-command',
          '{}',
          5,
        );
      }
      expect(
        db.prepare('SELECT id,event_type FROM thread_event ORDER BY id').all(),
      ).toEqual([
        { id: 41, event_type: 'thread.archive' },
        { id: 42, event_type: 'thread.restore' },
        { id: 43, event_type: 'thread.settle' },
        { id: 44, event_type: 'thread.unsettle' },
      ]);
    } finally {
      db.close();
    }
  });

  it('converts v10 settled durable rows without losing dependent data or indexes', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys=ON');
      runMigrations(db, DASHBOARD_MIGRATIONS.slice(0, 10));
      db.exec(`
        INSERT INTO project (id,title,root_path,default_isolation,max_parallel_runs,status,created_at,updated_at)
        VALUES ('rename-project','Rename','/rename','main',1,'active',1,1);
        INSERT INTO checkout (id,project_id,kind,path,status,created_at,updated_at)
        VALUES ('rename-checkout','rename-project','main','/rename','ready',2,2);
        INSERT INTO thread
          (id,project_id,title,checkout_id,status,pinned_at,created_at,updated_at,archived_at,pre_archive_status)
        VALUES ('rename-thread','rename-project','Rename thread','rename-checkout','settled',3,4,5,6,'settled');
        INSERT INTO orchestration_run
          (id,thread_id,checkout_id,attempt,mode,runtime_provider,runtime_id,pi_session_id,initial_prompt,status,created_at,started_at,finished_at,error)
        VALUES ('rename-run','rename-thread','rename-checkout',1,'write','pi-server','rename-runtime','rename-session','Rename prompt','settled',7,8,9,NULL);
        INSERT INTO orchestration_runtime
          (runtime_id,pi_session_id,run_id,status,created_at,updated_at)
        VALUES ('rename-runtime','rename-session','rename-run','stopped',10,11);
        INSERT INTO session_index (id,file,cwd,updated_at)
        VALUES ('rename-session','/rename/session.jsonl','/rename',12);
        INSERT INTO session_thread_link
          (session_id,thread_id,source,source_file,created_at,updated_at)
        VALUES ('rename-session','rename-thread','migration','/rename/session.jsonl',13,14);
        INSERT INTO thread_event
          (id,thread_id,event_type,command_id,actor,reason,payload_json,occurred_at)
        VALUES (7,'rename-thread','legacy.snapshot',NULL,'migration','legacy-snapshot','{"status":"settled"}',15);
        INSERT INTO command_receipt
          (idempotency_key,command_type,resource_type,resource_id,runtime_id,command_fingerprint,result_json,created_at)
        VALUES ('rename-command','thread.create','thread','rename-thread','rename-runtime',NULL,'{"thread":{"id":"rename-thread","projectId":"rename-project","title":"Rename thread","checkoutId":"rename-checkout","status":"settled","pinnedAt":5,"archivedAt":6,"preArchiveStatus":"settled","createdAt":3,"updatedAt":4},"run":{"id":"rename-run","threadId":"rename-thread","checkoutId":"rename-checkout","attempt":1,"mode":"write","runtimeProvider":"pi-server","runtimeId":"rename-runtime","piSessionId":"rename-session","initialPrompt":"Rename prompt","status":"settled","createdAt":7,"startedAt":8,"finishedAt":9}}',16);
      `);
      const indexesBefore = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('active_run_per_thread','active_runtime_per_pi_session','active_runtime_per_run','active_writer_per_checkout','orchestration_run_thread_attempt_unique','run_checkout_status','session_thread_link_thread','thread_event_thread_order') ORDER BY name",
        )
        .all();

      runMigrations(db);
      expect(
        db
          .prepare(
            'SELECT status,archived_at,pre_archive_status FROM thread WHERE id=?',
          )
          .get('rename-thread'),
      ).toEqual({
        status: 'completed',
        archived_at: 6,
        pre_archive_status: 'completed',
      });
      expect(
        db
          .prepare(
            'SELECT id,thread_id,runtime_id,pi_session_id,status,created_at,started_at,finished_at FROM orchestration_run WHERE id=?',
          )
          .get('rename-run'),
      ).toEqual({
        id: 'rename-run',
        thread_id: 'rename-thread',
        runtime_id: 'rename-runtime',
        pi_session_id: 'rename-session',
        status: 'completed',
        created_at: 7,
        started_at: 8,
        finished_at: 9,
      });
      expect(db.prepare('SELECT * FROM orchestration_runtime').all()).toEqual([
        {
          runtime_id: 'rename-runtime',
          pi_session_id: 'rename-session',
          run_id: 'rename-run',
          status: 'stopped',
          created_at: 10,
          updated_at: 11,
        },
      ]);
      expect(db.prepare('SELECT * FROM session_thread_link').all()).toEqual([
        {
          session_id: 'rename-session',
          thread_id: 'rename-thread',
          source: 'migration',
          source_file: '/rename/session.jsonl',
          created_at: 13,
          updated_at: 14,
        },
      ]);
      expect(db.prepare('SELECT * FROM thread_event').all()).toEqual([
        {
          id: 7,
          thread_id: 'rename-thread',
          event_type: 'legacy.snapshot',
          command_id: null,
          actor: 'migration',
          reason: 'legacy-snapshot',
          payload_json: '{"status":"settled"}',
          occurred_at: 15,
        },
      ]);
      expect(db.prepare('SELECT * FROM command_receipt').all()).toEqual([
        {
          idempotency_key: 'rename-command',
          command_type: 'thread.create',
          resource_type: 'thread',
          resource_id: 'rename-thread',
          result_json:
            '{"thread":{"id":"rename-thread","projectId":"rename-project","title":"Rename thread","checkoutId":"rename-checkout","status":"completed","pinnedAt":5,"archivedAt":6,"preArchiveStatus":"completed","createdAt":3,"updatedAt":4},"run":{"id":"rename-run","threadId":"rename-thread","checkoutId":"rename-checkout","attempt":1,"mode":"write","runtimeProvider":"extension-bridge","runtimeId":"rename-runtime","piSessionId":"rename-session","initialPrompt":"Rename prompt","status":"completed","createdAt":7,"startedAt":8,"finishedAt":9}}',
          created_at: 16,
          runtime_id: 'rename-runtime',
          command_fingerprint: null,
        },
      ]);
      const replayed = new SqliteOrchestrationRepository(db).getCommandReceipt(
        'rename-command',
      );
      expect(replayed?.result).toMatchObject({
        thread: { status: 'completed', preArchiveStatus: 'completed' },
        run: { status: 'completed' },
      });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('active_run_per_thread','active_runtime_per_pi_session','active_runtime_per_run','active_writer_per_checkout','orchestration_run_thread_attempt_unique','run_checkout_status','session_thread_link_thread','thread_event_thread_order') ORDER BY name",
          )
          .all(),
      ).toEqual(indexesBefore);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(
        db
          .prepare('SELECT seq FROM sqlite_sequence WHERE name=?')
          .get('thread_event'),
      ).toEqual({ seq: 7 });
      db.prepare(
        `INSERT INTO thread_event
         (thread_id,event_type,command_id,actor,reason,payload_json,occurred_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(
        'rename-thread',
        'thread.pin',
        'rename-event-2',
        'user',
        'user-command',
        '{}',
        17,
      );
      expect(
        db
          .prepare('SELECT id FROM thread_event WHERE command_id=?')
          .get('rename-event-2'),
      ).toEqual({ id: 8 });

      expect(() =>
        db
          .prepare(
            `INSERT INTO thread (id,project_id,title,checkout_id,status,created_at,updated_at)
             VALUES ('rejected-thread','rename-project','Rejected','rename-checkout','settled',20,20)`,
          )
          .run(),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO orchestration_run
             (id,thread_id,checkout_id,attempt,mode,runtime_provider,initial_prompt,status,created_at)
             VALUES ('rejected-run','rename-thread','rename-checkout',2,'write','extension-bridge','Rejected','settled',20)`,
          )
          .run(),
      ).toThrow();
      expect(() =>
        db
          .prepare('UPDATE thread SET pre_archive_status=? WHERE id=?')
          .run('settled', 'rename-thread'),
      ).toThrow();
      db.exec(`
        INSERT INTO thread (id,project_id,title,checkout_id,status,created_at,updated_at)
        VALUES ('accepted-thread','rename-project','Accepted','rename-checkout','completed',21,21);
        INSERT INTO orchestration_run
          (id,thread_id,checkout_id,attempt,mode,runtime_provider,initial_prompt,status,created_at)
        VALUES ('accepted-run','accepted-thread','rename-checkout',1,'read','extension-bridge','Accepted','completed',21);
      `);
      expect(
        db
          .prepare('SELECT status FROM orchestration_run WHERE id=?')
          .get('accepted-run'),
      ).toEqual({ status: 'completed' });
      expect(
        db
          .prepare(
            'SELECT version,name FROM schema_migrations WHERE version=11',
          )
          .get(),
      ).toEqual({
        version: 11,
        name: 'rename-settled-orchestration-status-to-completed',
      });
      runMigrations(db);
      expect(
        db
          .prepare(
            'SELECT count(*) AS count FROM schema_migrations WHERE version=11',
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('does not record v10 when the orchestration foundation is missing', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
        INSERT INTO schema_migrations (version,name,applied_at)
        VALUES
          (1,'base-dashboard-metadata',1),
          (2,'managed-launch-credentials',2),
          (3,'durable-orchestration-foundation',3),
          (4,'durable-worktree-records-and-project-identity',4),
          (5,'project-scoped-checkout-branches',5),
          (6,'managed-launch-mode',6),
          (7,'worktree-owner-projection',7),
          (8,'reconcile-worktree-owner-and-command-receipts',8),
          (9,'durable-thread-lifecycle-projection',9);
      `);
      expect(() => runMigrations(db)).toThrow(
        'Durable session links require the orchestration foundation.',
      );
      expect(
        db.prepare('SELECT 1 FROM schema_migrations WHERE version=10').get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
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
      runMigrations(db, DASHBOARD_MIGRATIONS.slice(0, 6));
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
        status: 'completed',
        archived_at: 30,
        pre_archive_status: 'completed',
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
