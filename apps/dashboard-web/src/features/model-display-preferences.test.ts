import { describe, expect, it, vi } from 'vitest';
import {
  modelDisplayPreferenceKey,
  readModelDisplayPreferences,
  resetModelDisplayPreference,
  setModelDisplayPreference,
} from './model-display-preferences';

describe('model display preferences', () => {
  it('stores aliases and colors by provider/model, validates colors, and resets entries', () => {
    const values = new Map<string, string>();
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
      setModelDisplayPreference('anthropic', 'claude-3', {
        alias: 'Claude',
        color: 'red',
      });
      expect(readModelDisplayPreferences()).toEqual({
        'anthropic/claude-3': { alias: 'Claude' },
      });
      setModelDisplayPreference('anthropic', 'claude-3', {
        alias: 'Claude',
        color: '#ff79c6',
      });
      expect(readModelDisplayPreferences()).toMatchObject({
        'anthropic/claude-3': { alias: 'Claude', color: '#ff79c6' },
      });
      resetModelDisplayPreference('anthropic', 'claude-3');
      expect(readModelDisplayPreferences()).toEqual({});
      expect(values.get('pi-dashboard-model-display-preferences-v1')).toBe(
        undefined,
      );
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
      vi.restoreAllMocks();
    }
  });
});
