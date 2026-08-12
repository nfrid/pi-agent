import { describe, expect, it, vi } from 'vitest';
import {
  composerDraftStorageKey,
  readComposerDraft,
  writeComposerDraft,
} from './draft';

describe('composer draft storage', () => {
  it('isolates drafts by encoded session and removes empty values', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    try {
      const firstKey = composerDraftStorageKey('session/one');
      expect(firstKey).not.toBe(composerDraftStorageKey('session-two'));
      writeComposerDraft('session/one', 'Keep this message');
      writeComposerDraft('session-two', 'Keep the other message');
      expect(readComposerDraft('session/one')).toBe('Keep this message');
      expect(readComposerDraft('session-two')).toBe('Keep the other message');
      writeComposerDraft('session/one', '');
      expect(readComposerDraft('session/one')).toBe('');
      expect(values.has(firstKey)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('degrades safely when local storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('unavailable');
      },
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {
        throw new Error('unavailable');
      },
    });
    try {
      expect(readComposerDraft('session')).toBe('');
      expect(() => writeComposerDraft('session', 'draft')).not.toThrow();
      expect(() => writeComposerDraft('session', '')).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
