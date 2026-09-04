import type { ModelSelection } from '@pi-dashboard/protocol';
import { useSyncExternalStore } from 'react';
import { readComposerDraft, writeComposerDraft } from './composer/draft';

export type DraftIsolation = 'worktree' | 'main';
export type DraftLocation =
  | { kind: 'current' }
  | { kind: 'worktree'; base: 'work' | 'head' }
  | { kind: 'worktree'; base: 'branch'; baseRef: string }
  | { kind: 'checkout'; checkoutId: string };

export type DraftMetadata = {
  id: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
  isolation: DraftIsolation;
  /** Persisted picker state; absent legacy drafts use isolation as a fallback. */
  location?: DraftLocation;
  title?: string;
  promotedThreadId?: string;
  promotionAttempt?: number;
  model?: ModelSelection;
};

const DRAFTS_STORAGE_KEY = 'pi-dashboard-drafts:v1';
const DRAFTS_CHANGE_EVENT = 'pi-dashboard-drafts-change';
let cachedDrafts: DraftMetadata[] | undefined;

function validModel(value: unknown): value is ModelSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  return (
    typeof model.provider === 'string' &&
    model.provider.length > 0 &&
    model.provider.length <= 200 &&
    typeof model.model === 'string' &&
    model.model.length > 0 &&
    model.model.length <= 300 &&
    (model.thinking === undefined ||
      (typeof model.thinking === 'string' &&
        model.thinking.length > 0 &&
        model.thinking.length <= 64)) &&
    (model.serviceTier === undefined ||
      model.serviceTier === 'fast' ||
      model.serviceTier === 'ultrafast')
  );
}

function validLocation(value: unknown): value is DraftLocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const location = value as Record<string, unknown>;
  if (location.kind === 'current') return true;
  if (location.kind === 'checkout')
    return (
      typeof location.checkoutId === 'string' && location.checkoutId.length > 0
    );
  if (location.kind !== 'worktree') return false;
  if (location.base === 'work' || location.base === 'head') return true;
  return (
    location.base === 'branch' &&
    typeof location.baseRef === 'string' &&
    location.baseRef.trim().length > 0 &&
    location.baseRef.length <= 512
  );
}

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
    (draft.location === undefined || validLocation(draft.location)) &&
    (draft.title === undefined ||
      (typeof draft.title === 'string' && draft.title.length <= 96)) &&
    (draft.promotedThreadId === undefined ||
      (typeof draft.promotedThreadId === 'string' &&
        draft.promotedThreadId.length > 0)) &&
    (draft.promotionAttempt === undefined ||
      (typeof draft.promotionAttempt === 'number' &&
        Number.isInteger(draft.promotionAttempt) &&
        draft.promotionAttempt >= 0)) &&
    (draft.model === undefined || validModel(draft.model))
  );
}

function readStoredDrafts(): DraftMetadata[] | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(DRAFTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validDraft);
  } catch {
    return undefined;
  }
}

export function readDrafts(): DraftMetadata[] {
  return readStoredDrafts() ?? [];
}

function currentDrafts(): DraftMetadata[] {
  if (!cachedDrafts) cachedDrafts = readDrafts();
  return cachedDrafts;
}

function freshDrafts(): DraftMetadata[] {
  const drafts = readStoredDrafts();
  if (drafts) {
    cachedDrafts = drafts;
    return drafts;
  }
  return currentDrafts();
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

export function draftRetryCommandId(draftId: string, attempt: number): string {
  return `draft-retry-${draftId}-${attempt}`;
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
    location:
      isolation === 'main'
        ? { kind: 'current' }
        : { kind: 'worktree', base: 'work' },
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

export function setDraftLocation(
  draftId: string,
  location: DraftLocation,
): void {
  const drafts = freshDrafts();
  persistDrafts(
    drafts.map((draft) =>
      draft.id === draftId
        ? {
            ...draft,
            location,
            isolation:
              location.kind === 'current' || location.kind === 'checkout'
                ? 'main'
                : 'worktree',
            updatedAt: Date.now(),
          }
        : draft,
    ),
  );
}

export function setDraftModel(draftId: string, model: ModelSelection): void {
  const drafts = freshDrafts();
  persistDrafts(
    drafts.map((draft) =>
      draft.id === draftId ? { ...draft, model, updatedAt: Date.now() } : draft,
    ),
  );
}

export function markDraftPromoted(
  draftId: string,
  promotedThreadId: string,
): void {
  const drafts = freshDrafts();
  persistDrafts(
    drafts.map((draft) =>
      draft.id === draftId
        ? {
            ...draft,
            promotedThreadId,
            promotionAttempt: 0,
            updatedAt: Date.now(),
          }
        : draft,
    ),
  );
}

export function beginDraftRetry(
  draftId: string,
): { threadId: string; attempt: number; commandId: string } | undefined {
  const drafts = freshDrafts();
  const draft = drafts.find((candidate) => candidate.id === draftId);
  if (!draft?.promotedThreadId) return undefined;
  const attempt = (draft.promotionAttempt ?? 0) + 1;
  persistDrafts(
    drafts.map((candidate) =>
      candidate.id === draftId
        ? { ...candidate, promotionAttempt: attempt, updatedAt: Date.now() }
        : candidate,
    ),
  );
  return {
    threadId: draft.promotedThreadId,
    attempt,
    commandId: draftRetryCommandId(draftId, attempt),
  };
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
