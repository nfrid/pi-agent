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
  it('updates and resets one model without replacing unrelated entries', () => {
    const settings = repository();
    expect(settings.read()).toEqual({ modelDisplayPreferences: {} });
    settings.set('openai/gpt-5', { alias: 'GPT', color: '#ff79c6' });
    expect(settings.set('anthropic/claude-3', { alias: 'Claude' })).toEqual({
      modelDisplayPreferences: {
        'anthropic/claude-3': { alias: 'Claude' },
        'openai/gpt-5': { alias: 'GPT', color: '#ff79c6' },
      },
    });
    expect(settings.reset('openai/gpt-5')).toEqual({
      modelDisplayPreferences: { 'anthropic/claude-3': { alias: 'Claude' } },
    });
  });

  it('imports only missing keys and keeps existing server values', () => {
    const settings = repository();
    settings.set('openai/gpt-5', { alias: 'Server name' });
    expect(
      settings.importMissing({
        'openai/gpt-5': { alias: 'Stale local' },
        'anthropic/claude-3': { alias: 'Claude' },
      }),
    ).toEqual({
      modelDisplayPreferences: {
        'anthropic/claude-3': { alias: 'Claude' },
        'openai/gpt-5': { alias: 'Server name' },
      },
    });
  });

  it('rejects invalid values before changing stored state', () => {
    const settings = repository();
    expect(() => settings.set('openai/gpt-5', { color: 'red' })).toThrow();
    expect(settings.read()).toEqual({ modelDisplayPreferences: {} });
  });
});
