import type { DatabaseSync } from 'node:sqlite';

export interface DashboardMigration {
  readonly version: number;
  readonly name: string;
  /** This migration rebuilds a table referenced by foreign keys. */
  readonly foreignKeysOff?: boolean;
  readonly up: (db: DatabaseSync) => void;
}

const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspace (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    active INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runtime (
    id TEXT PRIMARY KEY,
    ownership TEXT NOT NULL,
    session_id TEXT,
    cwd TEXT NOT NULL,
    state TEXT NOT NULL,
    online INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_index (
    id TEXT PRIMARY KEY,
    file TEXT NOT NULL UNIQUE,
    cwd TEXT NOT NULL,
    workspace_id TEXT,
    name TEXT,
    updated_at INTEGER NOT NULL,
    entry_count INTEGER
  );
  CREATE TABLE IF NOT EXISTS managed_launch (
    runtime_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    tmux_session TEXT NOT NULL,
    tmux_window_id TEXT NOT NULL,
    tmux_pane_id TEXT NOT NULL,
    launched_at INTEGER NOT NULL,
    stopped_at INTEGER,
    identity_token_hash TEXT,
    launch_token_hash TEXT,
    launch_consumed INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'write' CHECK (mode IN ('read','write'))
  );
  CREATE TABLE IF NOT EXISTS interaction (
    id TEXT PRIMARY KEY,
    runtime_id TEXT,
    session_id TEXT,
    status TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notification (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    runtime_id TEXT,
    session_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS push_subscription (
    endpoint TEXT PRIMARY KEY,
    subscription_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name)),
  );
}

export const DASHBOARD_MIGRATIONS: readonly DashboardMigration[] = [
  {
    version: 1,
    name: 'base-dashboard-metadata',
    up(db) {
      db.exec(BASE_SCHEMA);
    },
  },
  {
    version: 2,
    name: 'managed-launch-credentials',
    up(db) {
      const existing = columns(db, 'managed_launch');
      if (!existing.has('identity_token_hash'))
        db.exec(
          'ALTER TABLE managed_launch ADD COLUMN identity_token_hash TEXT',
        );
      if (!existing.has('launch_token_hash'))
        db.exec('ALTER TABLE managed_launch ADD COLUMN launch_token_hash TEXT');
      if (!existing.has('launch_consumed'))
        db.exec(
          'ALTER TABLE managed_launch ADD COLUMN launch_consumed INTEGER NOT NULL DEFAULT 0',
        );
    },
  },
  {
    version: 3,
    name: 'durable-orchestration-foundation',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          root_path TEXT NOT NULL,
          repository_identity TEXT,
          default_base_branch TEXT,
          default_model_json TEXT,
          default_isolation TEXT NOT NULL CHECK (default_isolation IN ('worktree','main')),
          max_parallel_runs INTEGER NOT NULL CHECK (max_parallel_runs BETWEEN 1 AND 1024),
          status TEXT NOT NULL CHECK (status IN ('active','archived')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS checkout (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES project(id),
          kind TEXT NOT NULL CHECK (kind IN ('main','worktree','external')),
          path TEXT NOT NULL UNIQUE,
          branch TEXT,
          base_sha TEXT,
          status TEXT NOT NULL CHECK (status IN ('preparing','ready','dirty','merging','retired','failed')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS thread (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES project(id),
          title TEXT NOT NULL,
          checkout_id TEXT REFERENCES checkout(id),
          status TEXT NOT NULL CHECK (status IN ('draft','queued','active','needs-input','settled','failed','stopped','archived')),
          pinned_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orchestration_run (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES thread(id),
          checkout_id TEXT NOT NULL REFERENCES checkout(id),
          attempt INTEGER NOT NULL CHECK (attempt >= 1),
          parent_run_id TEXT REFERENCES orchestration_run(id),
          mode TEXT NOT NULL CHECK (mode IN ('read','write')),
          runtime_provider TEXT NOT NULL CHECK (runtime_provider IN ('extension-bridge','pi-server')),
          runtime_id TEXT,
          pi_session_id TEXT,
          initial_prompt TEXT NOT NULL CHECK (length(initial_prompt) BETWEEN 1 AND 100000),
          model_json TEXT,
          status TEXT NOT NULL CHECK (status IN ('queued','preparing','starting','running','waiting','settled','failed','cancelled','interrupted')),
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          error TEXT
        );
        CREATE TABLE IF NOT EXISTS orchestration_runtime (
          runtime_id TEXT PRIMARY KEY,
          pi_session_id TEXT NOT NULL,
          run_id TEXT REFERENCES orchestration_run(id),
          status TEXT NOT NULL CHECK (status IN ('starting','running','stopped','failed')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS command_receipt (
          idempotency_key TEXT PRIMARY KEY,
          command_type TEXT NOT NULL,
          resource_type TEXT,
          resource_id TEXT,
          result_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS checkout_branch_unique
          ON checkout(branch) WHERE branch IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS active_run_per_thread
          ON orchestration_run(thread_id)
          WHERE status IN ('queued','preparing','starting','running','waiting');
        CREATE UNIQUE INDEX IF NOT EXISTS active_writer_per_checkout
          ON orchestration_run(checkout_id)
          WHERE mode = 'write' AND status IN ('queued','preparing','starting','running','waiting');
        CREATE UNIQUE INDEX IF NOT EXISTS active_runtime_per_pi_session
          ON orchestration_runtime(pi_session_id)
          WHERE status IN ('starting','running');
        CREATE UNIQUE INDEX IF NOT EXISTS active_runtime_per_run
          ON orchestration_runtime(run_id)
          WHERE run_id IS NOT NULL AND status IN ('starting','running');
        CREATE UNIQUE INDEX IF NOT EXISTS orchestration_run_thread_attempt_unique
          ON orchestration_run(thread_id, attempt);
        CREATE INDEX IF NOT EXISTS run_checkout_status
          ON orchestration_run(checkout_id, status);
      `);
    },
  },
  {
    version: 4,
    name: 'durable-worktree-records-and-project-identity',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS worktree_record (
          id TEXT PRIMARY KEY,
          checkout_id TEXT NOT NULL UNIQUE REFERENCES checkout(id),
          record_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS project_repository_identity_unique
          ON project(repository_identity) WHERE repository_identity IS NOT NULL;
      `);
    },
  },
  {
    version: 5,
    name: 'project-scoped-checkout-branches',
    foreignKeysOff: true,
    up(db) {
      // checkout is referenced by thread, orchestration_run, and
      // worktree_record. Rebuild it without changing those old migration
      // definitions: the runner temporarily disables FK enforcement around
      // this narrowly-scoped operation.
      db.exec(`
        CREATE TABLE checkout_v5 (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES project(id),
          kind TEXT NOT NULL CHECK (kind IN ('main','worktree','external')),
          path TEXT NOT NULL UNIQUE,
          branch TEXT,
          base_sha TEXT,
          status TEXT NOT NULL CHECK (status IN ('preparing','ready','dirty','merging','retired','failed')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO checkout_v5
          (id,project_id,kind,path,branch,base_sha,status,created_at,updated_at)
          SELECT id,project_id,kind,path,branch,base_sha,status,created_at,updated_at
          FROM checkout;
        DROP INDEX IF EXISTS checkout_branch_unique;
        DROP TABLE checkout;
        ALTER TABLE checkout_v5 RENAME TO checkout;
        CREATE UNIQUE INDEX checkout_project_branch_unique
          ON checkout(project_id,branch) WHERE branch IS NOT NULL;
      `);
    },
  },
  {
    version: 6,
    name: 'managed-launch-mode',
    up(db) {
      const existing = columns(db, 'managed_launch');
      if (!existing.has('mode'))
        db.exec(
          "ALTER TABLE managed_launch ADD COLUMN mode TEXT NOT NULL DEFAULT 'write' CHECK (mode IN ('read','write'))",
        );
    },
  },
  {
    version: 7,
    name: 'worktree-owner-projection',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS worktree_owner (
          checkout_id TEXT PRIMARY KEY REFERENCES checkout(id) ON DELETE CASCADE,
          owner_kind TEXT NOT NULL CHECK (owner_kind IN ('execution','delegate-session')),
          owner_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 8,
    name: 'reconcile-worktree-owner-and-command-receipts',
    up(db) {
      // Version 7 existed independently on two merged histories. Repair both
      // possible schemas so either ledger converges at version 8.
      db.exec(`
        CREATE TABLE IF NOT EXISTS worktree_owner (
          checkout_id TEXT PRIMARY KEY REFERENCES checkout(id) ON DELETE CASCADE,
          owner_kind TEXT NOT NULL CHECK (owner_kind IN ('execution','delegate-session')),
          owner_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      const tableExists = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='command_receipt'",
        )
        .get();
      if (!tableExists)
        db.exec(`
          CREATE TABLE command_receipt (
            idempotency_key TEXT PRIMARY KEY,
            command_type TEXT NOT NULL,
            resource_type TEXT,
            resource_id TEXT,
            result_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            runtime_id TEXT,
            command_fingerprint TEXT
          )
        `);
      else {
        const existing = columns(db, 'command_receipt');
        if (!existing.has('runtime_id'))
          db.exec('ALTER TABLE command_receipt ADD COLUMN runtime_id TEXT');
        if (!existing.has('command_fingerprint'))
          db.exec(
            'ALTER TABLE command_receipt ADD COLUMN command_fingerprint TEXT',
          );
      }
    },
  },
  {
    version: 9,
    name: 'durable-thread-lifecycle-projection',
    up(db) {
      // Adding nullable columns is safe on SQLite databases created by every
      // earlier migration. The old `archived` status is normalized below
      // before new lifecycle commands can observe the projection.
      const threadExists = Boolean(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread'",
          )
          .get(),
      );
      if (threadExists) {
        const threadColumns = columns(db, 'thread');
        if (!threadColumns.has('archived_at'))
          db.exec('ALTER TABLE thread ADD COLUMN archived_at INTEGER');
        if (!threadColumns.has('pre_archive_status'))
          db.exec('ALTER TABLE thread ADD COLUMN pre_archive_status TEXT');
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS thread_event (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL CHECK (event_type IN ('legacy.snapshot','thread.archive','thread.restore','thread.pin','thread.unpin')),
          command_id TEXT UNIQUE,
          actor TEXT NOT NULL CHECK (actor IN ('user','migration')),
          reason TEXT NOT NULL CHECK (reason IN ('user-command','legacy-snapshot')),
          payload_json TEXT NOT NULL,
          occurred_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS thread_event_thread_order
          ON thread_event(thread_id,id);
      `);

      if (threadExists) {
        // Older releases encoded visibility by replacing execution status with
        // `archived`. Recover the latest durable run projection when possible;
        // otherwise draft is the conservative restore target.
        db.exec(`
          UPDATE thread
          SET pre_archive_status = COALESCE(
                pre_archive_status,
                (SELECT CASE r.status
                  WHEN 'waiting' THEN 'needs-input'
                  WHEN 'settled' THEN 'settled'
                  WHEN 'failed' THEN 'failed'
                  WHEN 'cancelled' THEN 'stopped'
                  WHEN 'interrupted' THEN 'stopped'
                  WHEN 'queued' THEN 'queued'
                  WHEN 'preparing' THEN 'active'
                  WHEN 'starting' THEN 'active'
                  WHEN 'running' THEN 'active'
                  ELSE 'draft' END
                 FROM orchestration_run r
                 WHERE r.thread_id=thread.id
                 ORDER BY r.attempt DESC,r.id DESC LIMIT 1),
                'draft'
              ),
              archived_at = COALESCE(archived_at, updated_at)
          WHERE status='archived';
          UPDATE thread
          SET status=COALESCE(pre_archive_status,'draft')
          WHERE status='archived';

          INSERT INTO thread_event
            (thread_id,event_type,command_id,actor,reason,payload_json,occurred_at)
          SELECT t.id,'legacy.snapshot',NULL,'migration','legacy-snapshot',
                 json_object('status',t.status,'archivedAt',t.archived_at),
                 t.updated_at
          FROM thread t
          WHERE NOT EXISTS (
            SELECT 1 FROM thread_event e
            WHERE e.thread_id=t.id AND e.event_type='legacy.snapshot'
          )
          ORDER BY t.id;
        `);
      }
    },
  },
  {
    version: 10,
    name: 'durable-session-thread-links',
    up(db) {
      const projectExists = Boolean(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project'",
          )
          .get(),
      );
      const threadExists = Boolean(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread'",
          )
          .get(),
      );
      // Never record a successful v10 migration without its required schema;
      // a repaired foundation must be able to retry this migration later.
      if (!projectExists || !threadExists)
        throw new Error(
          'Durable session links require the orchestration foundation.',
        );
      const projectColumns = columns(db, 'project');
      if (!projectColumns.has('system_managed'))
        db.exec(
          'ALTER TABLE project ADD COLUMN system_managed INTEGER NOT NULL DEFAULT 0 CHECK (system_managed IN (0,1))',
        );

      db.exec(`
        CREATE TABLE IF NOT EXISTS session_thread_link (
          session_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL UNIQUE REFERENCES thread(id) ON DELETE RESTRICT,
          source TEXT NOT NULL,
          source_file TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS session_thread_link_thread
          ON session_thread_link(thread_id);
      `);

      // One shared system project keeps ordinary session links valid without
      // manufacturing a checkout or a run. It is omitted by all normal
      // project/thread catalogues through `system_managed`.
      const technicalProjectId = 'project-system-session-index';
      const now = Date.now();
      db.prepare(
        `INSERT OR IGNORE INTO project
         (id,title,root_path,repository_identity,default_base_branch,default_model_json,default_isolation,max_parallel_runs,status,created_at,updated_at,system_managed)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
      ).run(
        technicalProjectId,
        'System session links',
        '/__pi_dashboard_session_links__',
        null,
        null,
        null,
        'main',
        1,
        'active',
        now,
        now,
      );

      // Backfill only an exact, file-backed run/session join. A session with
      // multiple thread identities (or a thread used by multiple sessions)
      // remains deliberately unmapped. Startup adoption sees the same durable
      // candidates and keeps that session quarantined instead of guessing.
      const candidates = db
        .prepare(
          `SELECT r.pi_session_id AS session_id,r.thread_id,si.file AS source_file
           FROM orchestration_run r
           JOIN session_index si ON si.id=r.pi_session_id
           WHERE r.pi_session_id IS NOT NULL
           UNION
           SELECT o.pi_session_id AS session_id,r.thread_id,si.file AS source_file
           FROM orchestration_runtime o
           JOIN orchestration_run r ON r.id=o.run_id
           JOIN session_index si ON si.id=o.pi_session_id
           WHERE o.pi_session_id IS NOT NULL`,
        )
        .all() as Array<Record<string, unknown>>;
      const bySession = new Map<
        string,
        { threadId: string; sourceFile: string }[]
      >();
      for (const row of candidates) {
        const sessionId = String(row.session_id);
        const value = {
          threadId: String(row.thread_id),
          sourceFile: String(row.source_file),
        };
        const list = bySession.get(sessionId) ?? [];
        if (!list.some((item) => item.threadId === value.threadId))
          list.push(value);
        bySession.set(sessionId, list);
      }
      const byThread = new Map<string, string>();
      const ambiguousThreads = new Set<string>();
      for (const [sessionId, values] of bySession) {
        if (values.length !== 1) continue;
        const value = values[0];
        if (!value) continue;
        const prior = byThread.get(value.threadId);
        if (prior !== undefined && prior !== sessionId) {
          ambiguousThreads.add(value.threadId);
          continue;
        }
        byThread.set(value.threadId, sessionId);
      }
      const insert = db.prepare(
        `INSERT OR IGNORE INTO session_thread_link
         (session_id,thread_id,source,source_file,created_at,updated_at)
         VALUES (?,?,?,?,?,?)`,
      );
      for (const [sessionId, values] of bySession) {
        if (values.length !== 1) continue;
        const value = values[0];
        if (
          !value ||
          ambiguousThreads.has(value.threadId) ||
          byThread.get(value.threadId) !== sessionId
        )
          continue;
        insert.run(
          sessionId,
          value.threadId,
          'migration',
          value.sourceFile,
          now,
          now,
        );
      }
    },
  },
  {
    version: 11,
    name: 'rename-settled-orchestration-status-to-completed',
    foreignKeysOff: true,
    up(db) {
      // SQLite cannot alter a CHECK constraint in place. Rebuild only the two
      // durable status tables, retaining their column order and every row;
      // dependent tables and their data are left untouched while FK checks are
      // temporarily disabled by the migration runner.
      db.exec(`
        CREATE TABLE thread_v11 (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES project(id),
          title TEXT NOT NULL,
          checkout_id TEXT REFERENCES checkout(id),
          status TEXT NOT NULL CHECK (status IN ('draft','queued','active','needs-input','completed','failed','stopped','archived')),
          pinned_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER,
          pre_archive_status TEXT CHECK (pre_archive_status IS NULL OR pre_archive_status IN ('draft','queued','active','needs-input','completed','failed','stopped','archived'))
        );
        INSERT INTO thread_v11
          (id,project_id,title,checkout_id,status,pinned_at,created_at,updated_at,archived_at,pre_archive_status)
          SELECT id,project_id,title,checkout_id,
                 CASE status WHEN 'settled' THEN 'completed' ELSE status END,
                 pinned_at,created_at,updated_at,archived_at,
                 CASE pre_archive_status WHEN 'settled' THEN 'completed' ELSE pre_archive_status END
          FROM thread;
        DROP TABLE thread;
        ALTER TABLE thread_v11 RENAME TO thread;

        CREATE TABLE orchestration_run_v11 (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES thread(id),
          checkout_id TEXT NOT NULL REFERENCES checkout(id),
          attempt INTEGER NOT NULL CHECK (attempt >= 1),
          parent_run_id TEXT REFERENCES orchestration_run(id),
          mode TEXT NOT NULL CHECK (mode IN ('read','write')),
          runtime_provider TEXT NOT NULL CHECK (runtime_provider IN ('extension-bridge','pi-server')),
          runtime_id TEXT,
          pi_session_id TEXT,
          initial_prompt TEXT NOT NULL CHECK (length(initial_prompt) BETWEEN 1 AND 100000),
          model_json TEXT,
          status TEXT NOT NULL CHECK (status IN ('queued','preparing','starting','running','waiting','completed','failed','cancelled','interrupted')),
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          error TEXT
        );
        INSERT INTO orchestration_run_v11
          (id,thread_id,checkout_id,attempt,parent_run_id,mode,runtime_provider,runtime_id,pi_session_id,initial_prompt,model_json,status,created_at,started_at,finished_at,error)
          SELECT id,thread_id,checkout_id,attempt,parent_run_id,mode,runtime_provider,runtime_id,pi_session_id,initial_prompt,model_json,
                 CASE status WHEN 'settled' THEN 'completed' ELSE status END,
                 created_at,started_at,finished_at,error
          FROM orchestration_run;
        DROP TABLE orchestration_run;
        ALTER TABLE orchestration_run_v11 RENAME TO orchestration_run;

        CREATE UNIQUE INDEX active_run_per_thread
          ON orchestration_run(thread_id)
          WHERE status IN ('queued','preparing','starting','running','waiting');
        CREATE UNIQUE INDEX active_writer_per_checkout
          ON orchestration_run(checkout_id)
          WHERE mode = 'write' AND status IN ('queued','preparing','starting','running','waiting');
        CREATE UNIQUE INDEX orchestration_run_thread_attempt_unique
          ON orchestration_run(thread_id,attempt);
        CREATE INDEX run_checkout_status
          ON orchestration_run(checkout_id,status);
      `);
    },
  },
];

/** Apply each numbered migration exactly once, including on pre-migration DBs. */
export function runMigrations(
  db: DatabaseSync,
  migrations: readonly DashboardMigration[] = DASHBOARD_MIGRATIONS,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => Number(row.version)),
  );
  for (const migration of [...migrations].sort(
    (left, right) => left.version - right.version,
  )) {
    if (applied.has(migration.version)) continue;
    const foreignKeysEnabled = Boolean(
      (db.prepare('PRAGMA foreign_keys').get() as Record<string, unknown>)
        .foreign_keys,
    );
    if (migration.foreignKeysOff && foreignKeysEnabled)
      db.exec('PRAGMA foreign_keys=OFF');
    let transactionStarted = false;
    try {
      db.exec('BEGIN');
      transactionStarted = true;
      migration.up(db);
      if (migration.foreignKeysOff) {
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0)
          throw new Error('Foreign-key check failed after migration.');
      }
      db.prepare(
        'INSERT INTO schema_migrations (version,name,applied_at) VALUES (?,?,?)',
      ).run(migration.version, migration.name, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      if (transactionStarted)
        try {
          db.exec('ROLLBACK');
        } catch {
          /* preserve the original migration error */
        }
      throw error;
    } finally {
      if (migration.foreignKeysOff && foreignKeysEnabled)
        db.exec('PRAGMA foreign_keys=ON');
    }
  }
}
