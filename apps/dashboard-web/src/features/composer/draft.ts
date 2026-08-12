import { useCallback, useEffect, useRef, useState } from 'react';

export const COMPOSER_DRAFT_STORAGE_PREFIX = 'pi-dashboard-composer-draft:';
export const COMPOSER_DRAFT_WRITE_DELAY = 350;

export function composerDraftStorageKey(sessionId: string): string {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}${encodeURIComponent(sessionId)}`;
}

export function readComposerDraft(sessionId: string): string {
  try {
    return (
      globalThis.localStorage?.getItem(composerDraftStorageKey(sessionId)) ?? ''
    );
  } catch {
    return '';
  }
}

export function writeComposerDraft(sessionId: string, text: string): void {
  try {
    const key = composerDraftStorageKey(sessionId);
    if (text) globalThis.localStorage?.setItem(key, text);
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // Draft persistence is best-effort when storage is unavailable or full.
  }
}

export function useComposerDraft(sessionId: string) {
  const [initialDraft] = useState(() => readComposerDraft(sessionId));
  const [text, setText] = useState(initialDraft);
  const draftTextRef = useRef(initialDraft);
  const updateText = useCallback((next: string) => {
    draftTextRef.current = next;
    setText(next);
  }, []);
  const clearDraft = useCallback(() => {
    draftTextRef.current = '';
    writeComposerDraft(sessionId, '');
    setText('');
  }, [sessionId]);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => writeComposerDraft(sessionId, text),
      COMPOSER_DRAFT_WRITE_DELAY,
    );
    return () => window.clearTimeout(timeout);
  }, [sessionId, text]);
  useEffect(
    () => () => writeComposerDraft(sessionId, draftTextRef.current),
    [sessionId],
  );

  return { initialDraft, text, updateText, clearDraft };
}
