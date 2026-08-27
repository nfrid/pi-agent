import { describe, expect, it, vi } from 'vitest';
import {
  modelDisplayPreference,
  modelDisplayPreferenceKey,
  readModelDisplayPreferences,
  removeStoredModelDisplayPreferences,
} from './model-display-preferences';

describe('model display preferences', () => {
  it('reads and removes the v1 migration store while validating colors', () => {
    const values = new Map<string, string>([
      [
        'pi-dashboard-model-display-preferences-v1',
        JSON.stringify({
          'anthropic/claude-3': { alias: 'Claude', color: 'red' },
          'openai/gpt-5': { alias: 'GPT', color: '#ff79c6' },
        }),
      ],
    ]);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    try {
      expect(modelDisplayPreferenceKey('anthropic', 'claude-3')).toBe(
        'anthropic/claude-3',
      );
      expect(readModelDisplayPreferences()).toEqual({
        'anthropic/claude-3': { alias: 'Claude' },
        'openai/gpt-5': { alias: 'GPT', color: '#ff79c6' },
      });
      removeStoredModelDisplayPreferences();
      expect(
        values.get('pi-dashboard-model-display-preferences-v1'),
      ).toBeUndefined();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
      vi.restoreAllMocks();
    }
  });

  it('reuses one unambiguous model preference across provider identities', () => {
    const preferences = {
      'runtime-provider/gpt-5.6-sol': { alias: 'sol', color: '#ff79c6' },
    };
    expect(
      modelDisplayPreference(preferences, 'usage-provider', 'gpt-5.6-sol'),
    ).toEqual({ alias: 'sol', color: '#ff79c6' });
    expect(
      modelDisplayPreference(
        {
          ...preferences,
          'other-provider/gpt-5.6-sol': { alias: 'other' },
        },
        'usage-provider',
        'gpt-5.6-sol',
      ),
    ).toEqual({});
  });
});
