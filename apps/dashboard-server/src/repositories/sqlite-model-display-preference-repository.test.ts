import { DatabaseSync } from 'node:sqlite';
import { MAX_MODEL_DISPLAY_PREFERENCES } from '@pi-dashboard/protocol';
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

  it('enforces the preference cap without committing a 513th row', () => {
    const settings = repository();
    const full = Object.fromEntries(
      Array.from({ length: MAX_MODEL_DISPLAY_PREFERENCES }, (_, index) => [
        `provider/model-${index}`,
        { alias: `Model ${index}` },
      ]),
    );
    expect(
      Object.keys(settings.importMissing(full).modelDisplayPreferences),
    ).toHaveLength(MAX_MODEL_DISPLAY_PREFERENCES);
    expect(settings.set('provider/model-511', { alias: 'Updated' })).toEqual(
      expect.objectContaining({
        modelDisplayPreferences: expect.objectContaining({
          'provider/model-511': { alias: 'Updated' },
        }),
      }),
    );
    expect(() =>
      settings.set('provider/model-512', { alias: 'Rejected' }),
    ).toThrow('Too many model display preferences.');
    expect(Object.keys(settings.read().modelDisplayPreferences)).toHaveLength(
      MAX_MODEL_DISPLAY_PREFERENCES,
    );
  });

  it('counts only missing keys when importing at the preference cap', () => {
    const settings = repository();
    settings.set('provider/model-0', { alias: 'Server' });
    const incoming = Object.fromEntries(
      Array.from({ length: MAX_MODEL_DISPLAY_PREFERENCES }, (_, index) => [
        `provider/model-${index}`,
        { alias: `Local ${index}` },
      ]),
    );
    expect(
      Object.keys(settings.importMissing(incoming).modelDisplayPreferences),
    ).toHaveLength(MAX_MODEL_DISPLAY_PREFERENCES);
    expect(settings.read().modelDisplayPreferences['provider/model-0']).toEqual(
      { alias: 'Server' },
    );

    const constrained = repository();
    constrained.set('provider/existing', { alias: 'Existing' });
    const allMissing = Object.fromEntries(
      Array.from({ length: MAX_MODEL_DISPLAY_PREFERENCES }, (_, index) => [
        `provider/new-${index}`,
        { alias: `New ${index}` },
      ]),
    );
    expect(() => constrained.importMissing(allMissing)).toThrow(
      'Too many model display preferences.',
    );
    expect(constrained.read()).toEqual({
      modelDisplayPreferences: { 'provider/existing': { alias: 'Existing' } },
    });
  });

  it('round-trips special model keys as own properties', () => {
    const imported = JSON.parse(
      '{"__proto__":{"alias":"Prototype"},"constructor":{"alias":"Constructor"}}',
    );
    const settings = repository();
    const importedSettings = settings.importMissing(imported);
    expect(
      Object.hasOwn(importedSettings.modelDisplayPreferences, '__proto__'),
    ).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(
        importedSettings.modelDisplayPreferences,
        '__proto__',
      )?.value,
    ).toEqual({ alias: 'Prototype' });
    expect(importedSettings.modelDisplayPreferences.constructor).toEqual({
      alias: 'Constructor',
    });

    const setSettings = repository();
    const read = setSettings.set('__proto__', { color: '#ff79c6' });
    expect(Object.hasOwn(read.modelDisplayPreferences, '__proto__')).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(read.modelDisplayPreferences, '__proto__')
        ?.value,
    ).toEqual({ color: '#ff79c6' });
  });

  it('rejects invalid values before changing stored state', () => {
    const settings = repository();
    expect(() => settings.set('openai/gpt-5', { color: 'red' })).toThrow();
    expect(settings.read()).toEqual({ modelDisplayPreferences: {} });
  });
});
