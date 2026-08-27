import { useSyncExternalStore } from 'react';

export type ModelDisplayPreference = {
  alias?: string;
  color?: string;
};

export type ModelDisplayPreferences = Record<string, ModelDisplayPreference>;

const STORAGE_KEY = 'pi-dashboard-model-display-preferences-v1';
const CHANGE_EVENT = 'pi-dashboard-model-display-preferences-change';
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
let cached: ModelDisplayPreferences | undefined;

export function modelDisplayPreferenceKey(
  provider: string,
  model: string,
): string {
  return `${provider}/${model}`;
}

function validPreference(value: unknown): value is ModelDisplayPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.alias === undefined ||
      (typeof candidate.alias === 'string' && candidate.alias.length <= 80)) &&
    (candidate.color === undefined ||
      (typeof candidate.color === 'string' &&
        COLOR_PATTERN.test(candidate.color)))
  );
}

function readStored(): ModelDisplayPreferences {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, ModelDisplayPreference] =>
          typeof entry[0] === 'string' && validPreference(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

export function readModelDisplayPreferences(): ModelDisplayPreferences {
  if (!cached) cached = readStored();
  return cached;
}

function snapshotModelDisplayPreferences(): ModelDisplayPreferences {
  if (!cached) cached = readStored();
  return cached;
}

function publish(next: ModelDisplayPreferences): void {
  cached = next;
  try {
    if (Object.keys(next).length === 0)
      globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Preferences remain available for this page when storage is unavailable.
  }
  if (typeof globalThis.dispatchEvent === 'function')
    globalThis.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setModelDisplayPreference(
  provider: string,
  model: string,
  preference: ModelDisplayPreference,
): void {
  const key = modelDisplayPreferenceKey(provider, model);
  const next = { ...readModelDisplayPreferences() };
  const alias = preference.alias?.trim();
  const color = preference.color;
  const nextPreference = {
    ...(alias ? { alias: alias.slice(0, 80) } : {}),
    ...(color && COLOR_PATTERN.test(color) ? { color } : {}),
  };
  if (Object.keys(nextPreference).length === 0) delete next[key];
  else next[key] = nextPreference;
  publish(next);
}

export function resetModelDisplayPreference(
  provider: string,
  model: string,
): void {
  const next = { ...readModelDisplayPreferences() };
  delete next[modelDisplayPreferenceKey(provider, model)];
  publish(next);
}

function subscribe(listener: () => void): () => void {
  const onChange = () => {
    cached = undefined;
    listener();
  };
  globalThis.addEventListener(CHANGE_EVENT, onChange);
  globalThis.addEventListener('storage', onChange);
  return () => {
    globalThis.removeEventListener(CHANGE_EVENT, onChange);
    globalThis.removeEventListener('storage', onChange);
  };
}

export function useModelDisplayPreferences(): ModelDisplayPreferences {
  return useSyncExternalStore(
    subscribe,
    snapshotModelDisplayPreferences,
    () => ({}),
  );
}

export function modelDisplayPreference(
  preferences: ModelDisplayPreferences,
  provider: string,
  model: string,
): ModelDisplayPreference {
  return preferences[modelDisplayPreferenceKey(provider, model)] ?? {};
}
