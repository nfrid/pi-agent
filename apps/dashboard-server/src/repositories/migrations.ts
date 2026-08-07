import type { DatabaseSync } from 'node:sqlite';

export interface DashboardMigration {
  readonly version: number;
  readonly name: string;
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
    launch_consumed INTEGER NOT NULL DEFAULT 0
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
          branch TEXT UNIQUE,
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
          runtime_provider TEXT NOT NULL,
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
        CREATE INDEX IF NOT EXISTS run_thread_attempt
          ON orchestration_run(thread_id, attempt);
        CREATE INDEX IF NOT EXISTS run_checkout_status
          ON orchestration_run(checkout_id, status);
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
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (version,name,applied_at) VALUES (?,?,?)',
      ).run(migration.version, migration.name, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
