import { MAX_MODEL_DISPLAY_PREFERENCES } from '@pi-dashboard/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  migrateModelDisplayPreferences,
  modelDisplayPreference,
  modelDisplayPreferenceKey,
  normalizeModelDisplayPreference,
  readStoredModelDisplayPreferences,
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
      expect(readStoredModelDisplayPreferences().preferences).toEqual({
        'openai/gpt-5': { alias: 'GPT', color: '#ff79c6' },
      });
      expect(readStoredModelDisplayPreferences().complete).toBe(false);
      removeStoredModelDisplayPreferences();
      expect(
        values.get('pi-dashboard-model-display-preferences-v1'),
      ).toBeUndefined();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
      vi.restoreAllMocks();
    }
  });

  it('uploads missing local entries, preserves server winners, and removes v1 after success', async () => {
    const values = new Map([
      [
        'pi-dashboard-model-display-preferences-v1',
        JSON.stringify({
          'openai/gpt-5': { alias: 'Stale local' },
          'anthropic/claude-3': { alias: 'Claude' },
        }),
      ],
    ]);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
      },
    });
    const uploaded = {
      modelDisplayPreferences: {
        'openai/gpt-5': { alias: 'Server name' },
        'anthropic/claude-3': { alias: 'Claude' },
      },
    } as const;
    const invalidate = vi.fn(async () => undefined);
    const update = vi.fn(async () => uploaded);
    try {
      await expect(
        migrateModelDisplayPreferences(update, invalidate),
      ).resolves.toBe(true);
      expect(update).toHaveBeenCalledWith({
        'openai/gpt-5': { alias: 'Stale local' },
        'anthropic/claude-3': { alias: 'Claude' },
      });
      expect(invalidate).toHaveBeenCalledOnce();
      expect(values.has('pi-dashboard-model-display-preferences-v1')).toBe(
        false,
      );
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('retains local v1 and restores server state when migration upload fails', async () => {
    const key = 'pi-dashboard-model-display-preferences-v1';
    const values = new Map([
      [key, JSON.stringify({ 'openai/gpt-5': { alias: 'GPT' } })],
    ]);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (name: string) => values.get(name) ?? null,
        removeItem: (name: string) => values.delete(name),
      },
    });
    const invalidate = vi.fn(async () => undefined);
    let fail = true;
    const update = vi.fn(async (preferences) => {
      if (fail) {
        fail = false;
        throw new Error('offline');
      }
      return { modelDisplayPreferences: preferences };
    });
    try {
      await expect(
        migrateModelDisplayPreferences(update, invalidate),
      ).rejects.toThrow('offline');
      expect(invalidate).not.toHaveBeenCalled();
      expect(values.get(key)).toBeDefined();
      await expect(
        migrateModelDisplayPreferences(update, invalidate),
      ).resolves.toBe(true);
      expect(values.get(key)).toBeUndefined();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('retains oversized local data instead of truncating and deleting it', async () => {
    const key = 'pi-dashboard-model-display-preferences-v1';
    const local = Object.fromEntries(
      Array.from({ length: MAX_MODEL_DISPLAY_PREFERENCES + 1 }, (_, index) => [
        `provider/model-${index}`,
        { alias: `Model ${index}` },
      ]),
    );
    const values = new Map([[key, JSON.stringify(local)]]);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (name: string) => values.get(name) ?? null,
        removeItem: (name: string) => values.delete(name),
      },
    });
    const update = vi.fn();
    const invalidate = vi.fn(async () => undefined);
    try {
      const parsed = readStoredModelDisplayPreferences();
      expect(parsed.complete).toBe(false);
      expect(Object.keys(parsed.preferences)).toHaveLength(
        MAX_MODEL_DISPLAY_PREFERENCES + 1,
      );
      await expect(
        migrateModelDisplayPreferences(update, invalidate),
      ).resolves.toBe(false);
      expect(update).not.toHaveBeenCalled();
      expect(values.get(key)).toBeDefined();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('retains local data with unknown fields for a later migration attempt', async () => {
    const key = 'pi-dashboard-model-display-preferences-v1';
    const values = new Map([
      [key, '{"openai/gpt-5":{"alias":"x","extra":true}}'],
    ]);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (name: string) => values.get(name) ?? null,
        removeItem: (name: string) => values.delete(name),
      },
    });
    const update = vi.fn();
    const invalidate = vi.fn(async () => undefined);
    try {
      expect(readStoredModelDisplayPreferences().complete).toBe(false);
      await expect(
        migrateModelDisplayPreferences(update, invalidate),
      ).resolves.toBe(false);
      expect(values.get(key)).toBeDefined();
      expect(update).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('normalizes undefined fields before choosing an update or reset', () => {
    expect(
      normalizeModelDisplayPreference({ alias: undefined }),
    ).toBeUndefined();
    expect(
      normalizeModelDisplayPreference({ alias: undefined, color: '#ff79c6' }),
    ).toEqual({ color: '#ff79c6' });
    expect(normalizeModelDisplayPreference({ alias: 'GPT' })).toEqual({
      alias: 'GPT',
    });
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
