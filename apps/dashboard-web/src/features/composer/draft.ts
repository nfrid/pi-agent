import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

export const COMPOSER_DRAFT_STORAGE_PREFIX = 'pi-dashboard-composer-draft:';
export const COMPOSER_DRAFT_WRITE_DELAY = 350;

export type ComposerDraftRevision = string;
type PersistedDraft = { text: string; revision: ComposerDraftRevision };
type ComposerDraftState = PersistedDraft & {
  submissions: Map<ComposerDraftRevision, number>;
  listeners: Set<() => void>;
  dirty: boolean;
};

const draftStates = new Map<string, ComposerDraftState>();

export function composerDraftStorageKey(sessionId: string): string {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}${encodeURIComponent(sessionId)}`;
}

function newRevision(): ComposerDraftRevision {
  return Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function readStoredDraft(sessionId: string): {
  text: string;
  revision?: string;
} {
  let text = '';
  try {
    text =
      globalThis.localStorage?.getItem(composerDraftStorageKey(sessionId)) ??
      '';
    const value: unknown = JSON.parse(text);
    if (
      value &&
      typeof value === 'object' &&
      'version' in value &&
      value.version === 1 &&
      'text' in value &&
      typeof value.text === 'string' &&
      'revision' in value &&
      typeof value.revision === 'string' &&
      value.revision
    ) {
      return { text: value.text, revision: value.revision };
    }
  } catch {
    // Existing plain-text drafts are migrated on the next committed write.
  }
  return { text };
}

function draftState(sessionId: string): ComposerDraftState {
  const current = draftStates.get(sessionId);
  if (current) return current;
  const stored = readStoredDraft(sessionId);
  const state: ComposerDraftState = {
    text: stored.text,
    revision: stored.revision ?? newRevision(),
    submissions: new Map(),
    listeners: new Set(),
    dirty: false,
  };
  draftStates.set(sessionId, state);
  return state;
}

function maybeReleaseDraftState(
  sessionId: string,
  state: ComposerDraftState,
): void {
  if (
    !state.listeners.size &&
    !state.submissions.size &&
    !state.dirty &&
    draftStates.get(sessionId) === state
  )
    draftStates.delete(sessionId);
}

function notify(state: ComposerDraftState): void {
  for (const listener of state.listeners) listener();
}

function persistState(sessionId: string, state: ComposerDraftState): void {
  try {
    // A revision is proof of identity only when committed atomically with text.
    if (state.text)
      globalThis.localStorage.setItem(
        composerDraftStorageKey(sessionId),
        JSON.stringify({
          version: 1,
          text: state.text,
          revision: state.revision,
        }),
      );
    else globalThis.localStorage.removeItem(composerDraftStorageKey(sessionId));
    state.dirty = false;
  } catch {
    state.dirty = true;
  }
  maybeReleaseDraftState(sessionId, state);
}

export function readComposerDraft(sessionId: string): string {
  return draftStates.get(sessionId)?.text ?? readStoredDraft(sessionId).text;
}

function setText(state: ComposerDraftState, text: string): void {
  if (state.text === text) return;
  state.text = text;
  state.revision = newRevision();
  state.dirty = true;
  notify(state);
}

export function writeComposerDraft(sessionId: string, text: string): void {
  const state = draftState(sessionId);
  setText(state, text);
  persistState(sessionId, state);
}

export function composerDraftRevision(
  sessionId: string,
): ComposerDraftRevision {
  const state = draftState(sessionId);
  // Also gives legacy text a durable identity before promotion metadata uses it.
  persistState(sessionId, state);
  return state.revision;
}

/** Clear an acknowledged draft without removing text edited after submission. */
export function clearComposerDraftIfRevision(
  sessionId: string,
  revision: ComposerDraftRevision,
): boolean {
  const state = draftState(sessionId);
  if (state.revision !== revision) {
    maybeReleaseDraftState(sessionId, state);
    return false;
  }
  setText(state, '');
  persistState(sessionId, state);
  return true;
}

export function useComposerDraft(sessionId: string) {
  // Render reads are pure: suspended/abandoned renders never acquire an owner.
  const [initialDraft] = useState(() => readComposerDraft(sessionId));
  const subscribe = useCallback(
    (onChange: () => void) => {
      const state = draftState(sessionId);
      state.listeners.add(onChange);
      return () => {
        state.listeners.delete(onChange);
        persistState(sessionId, state);
      };
    },
    [sessionId],
  );
  const text = useSyncExternalStore(
    subscribe,
    () => readComposerDraft(sessionId),
    () => readComposerDraft(sessionId),
  );
  const updateText = useCallback(
    (next: string) => {
      setText(draftState(sessionId), next);
    },
    [sessionId],
  );
  const beginSubmission = useCallback(() => {
    const state = draftState(sessionId);
    const revision = state.revision;
    state.submissions.set(revision, (state.submissions.get(revision) ?? 0) + 1);
    persistState(sessionId, state);
    return revision;
  }, [sessionId]);
  const releaseSubmission = useCallback(
    (revision: ComposerDraftRevision) => {
      const state = draftStates.get(sessionId);
      if (!state) return;
      const count = state.submissions.get(revision) ?? 0;
      if (count <= 1) state.submissions.delete(revision);
      else state.submissions.set(revision, count - 1);
      maybeReleaseDraftState(sessionId, state);
    },
    [sessionId],
  );
  const acknowledgeDraft = useCallback(
    (revision: ComposerDraftRevision): boolean => {
      const matches = clearComposerDraftIfRevision(sessionId, revision);
      releaseSubmission(revision);
      return matches;
    },
    [releaseSubmission, sessionId],
  );

  useEffect(() => {
    const state = draftStates.get(sessionId);
    if (!state) return;
    const revision = state.revision;
    const timeout = window.setTimeout(() => {
      const current = draftStates.get(sessionId);
      if (current?.revision === revision && current.text === text)
        persistState(sessionId, current);
    }, COMPOSER_DRAFT_WRITE_DELAY);
    return () => window.clearTimeout(timeout);
  }, [sessionId, text]);

  return {
    initialDraft,
    text,
    updateText,
    beginSubmission,
    releaseSubmission,
    acknowledgeDraft,
  };
}
