import {
  dashboardHttpClient,
  dashboardQueryKeys,
  settingsQueryOptions,
} from '@pi-dashboard/client';
import type {
  ModelDisplayPreference,
  ModelDisplayPreferences,
} from '@pi-dashboard/protocol';
import {
  MAX_MODEL_DISPLAY_ALIAS,
  MAX_MODEL_DISPLAY_PREFERENCE_KEY,
  MAX_MODEL_DISPLAY_PREFERENCES,
} from '@pi-dashboard/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export type { ModelDisplayPreference, ModelDisplayPreferences };

const STORAGE_KEY = 'pi-dashboard-model-display-preferences-v1';
const EMPTY_MODEL_DISPLAY_PREFERENCES: ModelDisplayPreferences = {};
let migrationStarted = false;

export function modelDisplayPreferenceKey(
  provider: string,
  model: string,
): string {
  return `${provider}/${model}`;
}

/** Read the pre-server v1 store for one-time migration only. */
export function readModelDisplayPreferences(): ModelDisplayPreferences {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    const preferences: ModelDisplayPreferences = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        !key ||
        key.length > MAX_MODEL_DISPLAY_PREFERENCE_KEY ||
        Array.from(key).some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        }) ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value)
      )
        continue;
      const candidate = value as Record<string, unknown>;
      const alias =
        typeof candidate.alias === 'string' &&
        candidate.alias.length <= MAX_MODEL_DISPLAY_ALIAS
          ? candidate.alias
          : undefined;
      const color =
        typeof candidate.color === 'string' &&
        /^#[0-9a-f]{6}$/i.test(candidate.color)
          ? candidate.color
          : undefined;
      if (alias !== undefined || color !== undefined)
        preferences[key] = {
          ...(alias === undefined ? {} : { alias }),
          ...(color === undefined ? {} : { color }),
        };
    }
    return Object.fromEntries(
      Object.entries(preferences).slice(0, MAX_MODEL_DISPLAY_PREFERENCES),
    );
  } catch {
    return {};
  }
}

export function removeStoredModelDisplayPreferences(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private browsing or restricted frames.
  }
}

function mergeMissingPreferences(
  server: ModelDisplayPreferences,
  local: ModelDisplayPreferences,
): ModelDisplayPreferences {
  const merged = { ...server };
  for (const [key, preference] of Object.entries(local)) {
    if (
      merged[key] === undefined &&
      Object.keys(merged).length < MAX_MODEL_DISPLAY_PREFERENCES
    )
      merged[key] = preference;
  }
  return merged;
}

/** Query-backed server state with a one-time local-v1 migration. */
export function useModelDisplayPreferences(): ModelDisplayPreferences {
  const query = useQuery(settingsQueryOptions(dashboardHttpClient));
  const queryClient = useQueryClient();
  const [migrationPreferences, setMigrationPreferences] = useState<
    ModelDisplayPreferences | undefined
  >();
  const attempted = useRef(false);
  useEffect(() => {
    if (!query.data || attempted.current || migrationStarted) return;
    attempted.current = true;
    migrationStarted = true;
    const serverSettings = query.data;
    const local = readModelDisplayPreferences();
    const merged = mergeMissingPreferences(
      serverSettings.modelDisplayPreferences,
      local,
    );
    const hasMissingLocalPreference = Object.keys(local).some(
      (key) =>
        serverSettings.modelDisplayPreferences[key] === undefined &&
        merged[key] !== undefined,
    );
    if (!hasMissingLocalPreference) {
      removeStoredModelDisplayPreferences();
      return;
    }
    setMigrationPreferences(merged);
    const mergedSettings = {
      ...serverSettings,
      modelDisplayPreferences: merged,
    };
    queryClient.setQueryData(dashboardQueryKeys.settings(), mergedSettings);
    void dashboardHttpClient.updateSettings(mergedSettings).then(
      (updated) => {
        if (updated) {
          setMigrationPreferences(updated.modelDisplayPreferences);
          queryClient.setQueryData(dashboardQueryKeys.settings(), updated);
        }
        removeStoredModelDisplayPreferences();
      },
      () => {
        migrationStarted = false;
        queryClient.setQueryData(dashboardQueryKeys.settings(), serverSettings);
        setMigrationPreferences(undefined);
      },
    );
  }, [query.data, queryClient]);
  return (
    migrationPreferences ??
    query.data?.modelDisplayPreferences ??
    EMPTY_MODEL_DISPLAY_PREFERENCES
  );
}

export function modelDisplayPreference(
  preferences: ModelDisplayPreferences,
  provider: string,
  model: string,
): ModelDisplayPreference {
  const exact = preferences[modelDisplayPreferenceKey(provider, model)];
  if (exact) return exact;
  const suffix = `/${model}`;
  const matches = Object.entries(preferences).filter(([key]) =>
    key.endsWith(suffix),
  );
  return matches.length === 1 ? (matches[0]?.[1] ?? {}) : {};
}
