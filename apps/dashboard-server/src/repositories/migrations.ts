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
