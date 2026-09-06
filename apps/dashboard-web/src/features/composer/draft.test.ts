import { createElement, StrictMode, Suspense, useEffect } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPOSER_DRAFT_WRITE_DELAY,
  composerDraftRevision,
  composerDraftStorageKey,
  readComposerDraft,
  useComposerDraft,
  writeComposerDraft,
} from './draft';

describe('composer draft storage', () => {
  it('syncs a remounted editor after acknowledgement and blocks stale debounce writes', () => {
    const values = new Map<string, string>();
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const sessionId = 'acknowledged-session';
    let current!: ReturnType<typeof useComposerDraft>;
    let mounts = 0;
    function Probe() {
      current = useComposerDraft(sessionId);
      useEffect(() => {
        mounts += 1;
      }, []);
      return null;
    }
    const probe = () => createElement(StrictMode, null, createElement(Probe));
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(probe());
    });
    expect(mounts).toBe(2);
    act(() => current.updateText('submitted text'));
    const submittedRevision = current.beginSubmission();
    const acknowledgeOriginalMount = current.acknowledgeDraft;
    act(() => renderer.unmount());

    act(() => {
      renderer = create(probe());
    });
    expect(current.text).toBe('submitted text');
    act(() => {
      expect(acknowledgeOriginalMount(submittedRevision)).toBe(true);
    });
    expect(current.text).toBe('');
    act(() => {
      vi.advanceTimersByTime(COMPOSER_DRAFT_WRITE_DELAY + 1);
    });
    act(() => renderer.unmount());
    expect(readComposerDraft(sessionId)).toBe('');
    // A clean owner must be released, not hide subsequent persisted content.
    values.set(composerDraftStorageKey(sessionId), 'external text');
    expect(readComposerDraft(sessionId)).toBe('external text');

    writeComposerDraft(sessionId, 'newer text');
    act(() => {
      renderer = create(probe());
    });
    const newerRevision = current.beginSubmission();
    act(() => current.updateText('genuinely newer text'));
    expect(current.acknowledgeDraft(newerRevision)).toBe(false);
    expect(current.text).toBe('genuinely newer text');
    act(() => renderer.unmount());
    expect(readComposerDraft(sessionId)).toBe('genuinely newer text');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('retains pending and dirty owners but releases a settled clean owner', () => {
    const values = new Map<string, string>();
    let failWrites = false;
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failWrites) throw new Error('quota');
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key),
    });
    const id = 'bounded-owner';
    let current!: ReturnType<typeof useComposerDraft>;
    function Probe() {
      current = useComposerDraft(id);
      return null;
    }
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(StrictMode, null, createElement(Probe)));
    });
    act(() => current.updateText('pending text'));
    const revision = current.beginSubmission();
    act(() => renderer.unmount());
    values.set(composerDraftStorageKey(id), 'external text');
    expect(readComposerDraft(id)).toBe('pending text');
    current.releaseSubmission(revision);
    expect(readComposerDraft(id)).toBe('external text');

    act(() => {
      renderer = create(createElement(StrictMode, null, createElement(Probe)));
    });
    failWrites = true;
    act(() => current.updateText('failed write'));
    act(() => renderer.unmount());
    expect(readComposerDraft(id)).toBe('failed write');
    failWrites = false;
    writeComposerDraft(id, 'failed write');
    values.set(composerDraftStorageKey(id), 'external text after recovery');
    expect(readComposerDraft(id)).toBe('external text after recovery');
    vi.unstubAllGlobals();
  });

  it('does not retain state from an abandoned render', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
    });
    const id = 'abandoned-render';
    function Abandoned(): never {
      useComposerDraft(id);
      throw new Promise(() => {});
    }
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        createElement(Suspense, { fallback: null }, createElement(Abandoned)),
      );
    });
    act(() => renderer.unmount());
    values.set(composerDraftStorageKey(id), 'written after abandoned render');
    expect(readComposerDraft(id)).toBe('written after abandoned render');
    vi.unstubAllGlobals();
  });

  it('pairs new text with its revision in one write even when a second write would fail', async () => {
    const values = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => {
      values.set(key, value);
    });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem,
      removeItem: (key: string) => values.delete(key),
    });
    try {
      const id = 'atomic-revision';
      writeComposerDraft(id, 'submitted text');
      const submitted = composerDraftRevision(id);
      setItem.mockClear();
      setItem.mockImplementation((key, value) => {
        if (setItem.mock.calls.length > 1) throw new Error('quota');
        values.set(key, value);
      });
      writeComposerDraft(id, 'newer text');
      expect(setItem).toHaveBeenCalledTimes(1);
      vi.resetModules();
      const reloaded = await import('./draft');
      expect(reloaded.clearComposerDraftIfRevision(id, submitted)).toBe(false);
      expect(reloaded.readComposerDraft(id)).toBe('newer text');
      // A failed later write remains authoritative in memory, not the disk copy.
      reloaded.writeComposerDraft(id, 'unsaved newest text');
      expect(reloaded.clearComposerDraftIfRevision(id, submitted)).toBe(false);
      expect(reloaded.readComposerDraft(id)).toBe('unsaved newest text');
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
