import { useSyncExternalStore } from 'react';
import { readComposerDraft, writeComposerDraft } from './composer/draft';

export type DraftIsolation = 'worktree' | 'main';

export type DraftMetadata = {
  id: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
  isolation: DraftIsolation;
  title?: string;
};

const DRAFTS_STORAGE_KEY = 'pi-dashboard-drafts:v1';
const DRAFTS_CHANGE_EVENT = 'pi-dashboard-drafts-change';
let cachedDrafts: DraftMetadata[] | undefined;

function validDraft(value: unknown): value is DraftMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.id === 'string' &&
    draft.id.length > 0 &&
    typeof draft.projectId === 'string' &&
    draft.projectId.length > 0 &&
    typeof draft.createdAt === 'number' &&
    Number.isFinite(draft.createdAt) &&
    typeof draft.updatedAt === 'number' &&
    Number.isFinite(draft.updatedAt) &&
    (draft.isolation === 'worktree' || draft.isolation === 'main') &&
    (draft.title === undefined ||
      (typeof draft.title === 'string' && draft.title.length <= 96))
  );
}

export function readDrafts(): DraftMetadata[] {
  try {
    const raw = globalThis.localStorage?.getItem(DRAFTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validDraft);
  } catch {
    return [];
  }
}

function currentDrafts(): DraftMetadata[] {
  if (!cachedDrafts) cachedDrafts = readDrafts();
  return cachedDrafts;
}

function freshDrafts(): DraftMetadata[] {
  const drafts = readDrafts();
  cachedDrafts = drafts;
  return drafts;
}

function notifyDrafts(): void {
  globalThis.dispatchEvent?.(new Event(DRAFTS_CHANGE_EVENT));
}

function persistDrafts(drafts: DraftMetadata[]): void {
  try {
    globalThis.localStorage?.setItem(
      DRAFTS_STORAGE_KEY,
      JSON.stringify(drafts),
    );
  } catch {
    // Browser storage is best effort; the in-memory snapshot remains usable.
  }
  cachedDrafts = drafts;
  notifyDrafts();
}

function newDraftId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function draftPath(draftId: string): string {
  return `/drafts/${encodeURIComponent(draftId)}`;
}

export function draftPromotionCommandId(draftId: string): string {
  return `draft-promote-${draftId}`;
}

export function createDraft(
  projectId: string,
  isolation: DraftIsolation,
  now = Date.now(),
): DraftMetadata {
  const draft = {
    id: newDraftId(),
    projectId,
    createdAt: now,
    updatedAt: now,
    isolation,
  } satisfies DraftMetadata;
  persistDrafts([...freshDrafts(), draft]);
  return draft;
}

/** Reuse one empty draft and discard duplicate empty metadata for this project. */
export function getOrCreateDraft(
  projectId: string,
  isolation: DraftIsolation,
): DraftMetadata {
  const projectDrafts = freshDrafts()
    .filter((draft) => draft.projectId === projectId)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const empty = projectDrafts.find(
    (draft) => !readComposerDraft(draft.id).trim(),
  );
  if (empty) {
    const emptyIds = new Set(
      projectDrafts
        .filter(
          (draft) =>
            draft.id !== empty.id && !readComposerDraft(draft.id).trim(),
        )
        .map((draft) => draft.id),
    );
    if (emptyIds.size)
      persistDrafts(freshDrafts().filter((draft) => !emptyIds.has(draft.id)));
    return empty;
  }
  return createDraft(projectId, isolation);
}

export function updateDraft(draftId: string, title?: string): void {
  const drafts = freshDrafts();
  const draft = drafts.find((candidate) => candidate.id === draftId);
  if (!draft) return;
  persistDrafts(
    drafts.map((candidate) =>
      candidate.id === draftId
        ? {
            ...candidate,
            updatedAt: Date.now(),
            ...(title === undefined ? {} : { title }),
          }
        : candidate,
    ),
  );
}

export function deleteDraft(draftId: string): void {
  writeComposerDraft(draftId, '');
  persistDrafts(freshDrafts().filter((draft) => draft.id !== draftId));
}

function subscribeDrafts(onChange: () => void): () => void {
  const localListener = () => onChange();
  const storageListener = (event: StorageEvent) => {
    if (event.key !== null && event.key !== DRAFTS_STORAGE_KEY) return;
    cachedDrafts = undefined;
    onChange();
  };
  globalThis.addEventListener?.(DRAFTS_CHANGE_EVENT, localListener);
  globalThis.addEventListener?.('storage', storageListener);
  return () => {
    globalThis.removeEventListener?.(DRAFTS_CHANGE_EVENT, localListener);
    globalThis.removeEventListener?.('storage', storageListener);
  };
}

export function useDrafts(): readonly DraftMetadata[] {
  return useSyncExternalStore(subscribeDrafts, currentDrafts, () => []);
}

export const draftStorageKey = DRAFTS_STORAGE_KEY;
