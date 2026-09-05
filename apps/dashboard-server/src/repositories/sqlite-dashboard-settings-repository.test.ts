import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';
import { SqliteDashboardSettingsRepository } from './sqlite-dashboard-settings-repository.js';

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('SqliteDashboardSettingsRepository', () => {
  it('persists a global tuple and removes it on reset without changing its shape', () => {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    runMigrations(db);
    const settings = new SqliteDashboardSettingsRepository(db);
    expect(settings.readDefaultModel()).toBeUndefined();
    const model = {
      provider: 'openai-codex',
      model: 'gpt-5.6',
      thinking: 'high',
      serviceTier: 'fast' as const,
    };
    expect(settings.setDefaultModel(model)).toEqual(model);
    expect(settings.readDefaultModel()).toEqual(model);
    expect(settings.setDefaultModel(null)).toBeUndefined();
    expect(settings.readDefaultModel()).toBeUndefined();
  });
});
