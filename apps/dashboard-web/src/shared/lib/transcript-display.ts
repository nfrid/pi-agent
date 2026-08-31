import { useMemo, useSyncExternalStore } from 'react';

export const TRANSCRIPT_PREVIEW_MIN = 0;
export const TRANSCRIPT_PREVIEW_MAX = 10;
export const DEFAULT_TRANSCRIPT_PREVIEW = { start: 1, end: 3 } as const;

const STORAGE_KEY = 'pi-dashboard-transcript-preview-v1';
const CHANGE_EVENT = 'pi-dashboard-transcript-preview-change';
const DEFAULT_SNAPSHOT = `${DEFAULT_TRANSCRIPT_PREVIEW.start}:${DEFAULT_TRANSCRIPT_PREVIEW.end}`;

export type TranscriptPreviewPreference = {
  start: number;
  end: number;
};

function boundedCount(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(
    TRANSCRIPT_PREVIEW_MIN,
    Math.min(TRANSCRIPT_PREVIEW_MAX, Math.round(value)),
  );
}

export function normalizeTranscriptPreviewPreference(
  value: unknown,
): TranscriptPreviewPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ...DEFAULT_TRANSCRIPT_PREVIEW };
  const candidate = value as Record<string, unknown>;
  return {
    start: boundedCount(candidate.start, DEFAULT_TRANSCRIPT_PREVIEW.start),
    end: boundedCount(candidate.end, DEFAULT_TRANSCRIPT_PREVIEW.end),
  };
}

function encode(preference: TranscriptPreviewPreference): string {
  return `${preference.start}:${preference.end}`;
}

function decode(snapshot: string): TranscriptPreviewPreference {
  const [start, end] = snapshot.split(':').map(Number);
  return normalizeTranscriptPreviewPreference({ start, end });
}

function storedSnapshot(): string {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SNAPSHOT;
    return encode(normalizeTranscriptPreviewPreference(JSON.parse(raw)));
  } catch {
    return DEFAULT_SNAPSHOT;
  }
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export function setTranscriptPreviewPreference(
  preference: TranscriptPreviewPreference,
): void {
  const normalized = normalizeTranscriptPreviewPreference(preference);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    return;
  }
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useTranscriptPreviewPreference(): TranscriptPreviewPreference {
  const snapshot = useSyncExternalStore(
    subscribe,
    storedSnapshot,
    () => DEFAULT_SNAPSHOT,
  );
  return useMemo(() => decode(snapshot), [snapshot]);
}
