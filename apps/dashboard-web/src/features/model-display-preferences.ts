import {
  dashboardHttpClient,
  dashboardQueryKeys,
  importModelDisplayPreferencesMutationOptions,
  settingsQueryOptions,
} from '@pi-dashboard/client';
import type {
  DashboardSettings,
  ModelDisplayPreference,
  ModelDisplayPreferences,
} from '@pi-dashboard/protocol';
import {
  MAX_MODEL_DISPLAY_ALIAS,
  MAX_MODEL_DISPLAY_PREFERENCE_KEY,
  MAX_MODEL_DISPLAY_PREFERENCES,
} from '@pi-dashboard/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

export type { ModelDisplayPreference, ModelDisplayPreferences };

const STORAGE_KEY = 'pi-dashboard-model-display-preferences-v1';
const EMPTY_MODEL_DISPLAY_PREFERENCES: ModelDisplayPreferences = {};
let migrationStarted = false;

export interface StoredModelDisplayPreferences {
  preferences: ModelDisplayPreferences;
  /** False when valid local entries cannot all fit the server contract. */
  complete: boolean;
}

export function modelDisplayPreferenceKey(
  provider: string,
  model: string,
): string {
  return `${provider}/${model}`;
}

/** Read the pre-server v1 store for one-time migration only. */
export function readStoredModelDisplayPreferences(): StoredModelDisplayPreferences {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { preferences: {}, complete: true };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { preferences: {}, complete: false };
    const entries: Array<[string, ModelDisplayPreference]> = [];
    let complete = true;
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        complete = false;
        continue;
      }
      const candidate = value as Record<string, unknown>;
      if (
        Object.keys(candidate).some((key) => key !== 'alias' && key !== 'color')
      ) {
        complete = false;
        continue;
      }
      const hasAlias = candidate.alias !== undefined;
      const hasColor = candidate.color !== undefined;
      const validAlias =
        !hasAlias ||
        (typeof candidate.alias === 'string' &&
          candidate.alias.length <= MAX_MODEL_DISPLAY_ALIAS);
      const validColor =
        !hasColor ||
        (typeof candidate.color === 'string' &&
          /^#[0-9a-f]{6}$/i.test(candidate.color));
      if (!validAlias || !validColor) {
        complete = false;
        continue;
      }
      const alias = hasAlias ? (candidate.alias as string) : undefined;
      const color = hasColor ? (candidate.color as string) : undefined;
      if (alias === undefined && color === undefined) continue;
      if (
        !key ||
        key.length > MAX_MODEL_DISPLAY_PREFERENCE_KEY ||
        Array.from(key).some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        })
      ) {
        complete = false;
        continue;
      }
      entries.push([
        key,
        {
          ...(alias === undefined ? {} : { alias }),
          ...(color === undefined ? {} : { color }),
        },
      ]);
    }
    if (entries.length > MAX_MODEL_DISPLAY_PREFERENCES) complete = false;
    return { preferences: Object.fromEntries(entries), complete };
  } catch {
    return { preferences: {}, complete: false };
  }
}

export function normalizeModelDisplayPreference(
  preference: ModelDisplayPreference,
): ModelDisplayPreference | undefined {
  const normalized: ModelDisplayPreference = {};
  if (preference.alias !== undefined) normalized.alias = preference.alias;
  if (preference.color !== undefined) normalized.color = preference.color;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function removeStoredModelDisplayPreferences(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private browsing or restricted frames.
  }
}

/** Import local v1 values atomically on the server, then refresh its query. */
export async function migrateModelDisplayPreferences(
  importMissing: (
    preferences: ModelDisplayPreferences,
  ) => Promise<DashboardSettings>,
  invalidate: () => Promise<unknown>,
): Promise<boolean> {
  const local = readStoredModelDisplayPreferences();
  if (!local.complete) return false;
  if (Object.keys(local.preferences).length === 0) {
    removeStoredModelDisplayPreferences();
    return false;
  }
  await importMissing(local.preferences);
  removeStoredModelDisplayPreferences();
  await invalidate();
  return true;
}

/** Query-backed server state with a one-time local-v1 migration. */
export function useModelDisplayPreferences(): ModelDisplayPreferences {
  const query = useQuery(settingsQueryOptions(dashboardHttpClient));
  const importMutation = useMutation(
    importModelDisplayPreferencesMutationOptions(dashboardHttpClient),
  );
  const importPreferences = importMutation.mutateAsync;
  const queryClient = useQueryClient();
  const attempted = useRef(false);
  useEffect(() => {
    if (!query.data || attempted.current || migrationStarted) return;
    attempted.current = true;
    migrationStarted = true;
    void migrateModelDisplayPreferences(
      (preferences) => importPreferences(preferences),
      () =>
        queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.settings(),
        }),
    ).then(
      () => {
        migrationStarted = false;
      },
      () => {
        migrationStarted = false;
        attempted.current = false;
      },
    );
  }, [importPreferences, query.data, queryClient]);
  return query.data?.modelDisplayPreferences ?? EMPTY_MODEL_DISPLAY_PREFERENCES;
}

export function modelDisplayPreference(
  preferences: ModelDisplayPreferences,
  provider: string,
  model: string,
): ModelDisplayPreference {
  const exactKey = modelDisplayPreferenceKey(provider, model);
  if (Object.hasOwn(preferences, exactKey)) return preferences[exactKey] ?? {};
  const suffix = `/${model}`;
  const matches = Object.entries(preferences).filter(([key]) =>
    key.endsWith(suffix),
  );
  return matches.length === 1 ? (matches[0]?.[1] ?? {}) : {};
}
