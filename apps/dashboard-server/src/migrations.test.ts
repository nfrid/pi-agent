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
      1, 2,
    ]);
  });
});
