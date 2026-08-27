import type { DashboardSettings } from '@pi-dashboard/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  mergeModelDisplayPreferences,
  migrateModelDisplayPreferences,
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
    const server = {
      modelDisplayPreferences: {
        'openai/gpt-5': { alias: 'Server name' },
      },
    } as const;
    const uploaded = {
      modelDisplayPreferences: {
        'openai/gpt-5': { alias: 'Server name' },
        'anthropic/claude-3': { alias: 'Claude' },
      },
    } as const;
    const states: unknown[] = [];
    const update = vi.fn(async () => uploaded);
    try {
      expect(
        mergeModelDisplayPreferences(
          server.modelDisplayPreferences,
          readModelDisplayPreferences(),
        ),
      ).toEqual(uploaded.modelDisplayPreferences);
      await expect(
        migrateModelDisplayPreferences(server, update, (settings) =>
          states.push(settings),
        ),
      ).resolves.toEqual(uploaded);
      expect(update).toHaveBeenCalledWith(uploaded);
      expect(states).toEqual([uploaded, uploaded]);
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
    const server: DashboardSettings = { modelDisplayPreferences: {} };
    const states: unknown[] = [];
    let fail = true;
    const update = vi.fn(async (settings: DashboardSettings) => {
      if (fail) {
        fail = false;
        throw new Error('offline');
      }
      return settings;
    });
    try {
      await expect(
        migrateModelDisplayPreferences(server, update, (settings) =>
          states.push(settings),
        ),
      ).rejects.toThrow('offline');
      expect(states).toEqual([
        { modelDisplayPreferences: { 'openai/gpt-5': { alias: 'GPT' } } },
        server,
      ]);
      expect(values.get(key)).toBeDefined();
      await expect(
        migrateModelDisplayPreferences(server, update, (settings) =>
          states.push(settings),
        ),
      ).resolves.toEqual({
        modelDisplayPreferences: { 'openai/gpt-5': { alias: 'GPT' } },
      });
      expect(values.get(key)).toBeUndefined();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
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
