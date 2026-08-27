import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';
import { SqliteModelDisplayPreferenceRepository } from './sqlite-model-display-preference-repository.js';

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function repository(): SqliteModelDisplayPreferenceRepository {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  runMigrations(db);
  return new SqliteModelDisplayPreferenceRepository(db);
}

describe('SqliteModelDisplayPreferenceRepository', () => {
  it('replaces and reads the one server-wide settings projection', () => {
    const settings = repository();
    expect(settings.read()).toEqual({ modelDisplayPreferences: {} });
    expect(
      settings.replace({
        modelDisplayPreferences: {
          'anthropic/claude-3': { alias: 'Claude', color: '#ff79c6' },
          'openai/gpt-5': { alias: 'GPT' },
        },
      }),
    ).toEqual({
      modelDisplayPreferences: {
        'anthropic/claude-3': { alias: 'Claude', color: '#ff79c6' },
        'openai/gpt-5': { alias: 'GPT' },
      },
    });
    expect(
      settings.replace({
        modelDisplayPreferences: {
          'openai/gpt-5': { alias: 'New name' },
        },
      }),
    ).toEqual({
      modelDisplayPreferences: { 'openai/gpt-5': { alias: 'New name' } },
    });
  });

  it('rejects invalid aliases and colors before changing stored state', () => {
    const settings = repository();
    expect(() =>
      settings.replace({
        modelDisplayPreferences: {
          'openai/gpt-5': { color: 'red' },
        },
      } as never),
    ).toThrow();
    expect(settings.read()).toEqual({ modelDisplayPreferences: {} });
  });
});
