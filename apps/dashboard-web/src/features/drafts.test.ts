import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeComposerDraft } from './composer/draft';
import {
  createDraft,
  deleteDraft,
  draftPath,
  draftPromotionCommandId,
  getOrCreateDraft,
  readDrafts,
  updateDraft,
} from './drafts';

const values = new Map<string, string>();

function installStorage() {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
}

afterEach(() => {
  values.clear();
  vi.unstubAllGlobals();
});

describe('browser-local draft metadata', () => {
  it('rejects malformed storage without throwing', () => {
    installStorage();
    values.set('pi-dashboard-drafts:v1', '{not json');
    expect(readDrafts()).toEqual([]);
    values.set(
      'pi-dashboard-drafts:v1',
      JSON.stringify([{ id: 'incomplete' }]),
    );
    expect(readDrafts()).toEqual([]);
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
    expect(() => readDrafts()).not.toThrow();
    expect(() =>
      getOrCreateDraft('storage-failure-project', 'worktree'),
    ).not.toThrow();
  });

  it('reuses an empty draft, but preserves invested drafts by creating another', () => {
    installStorage();
    const empty = getOrCreateDraft('project/one', 'main');
    expect(getOrCreateDraft('project/one', 'worktree').id).toBe(empty.id);
    writeComposerDraft(empty.id, 'Keep this prompt');
    const invested = getOrCreateDraft('project/one', 'worktree');
    expect(invested.id).not.toBe(empty.id);
    expect(invested.isolation).toBe('worktree');
    expect(
      readDrafts().filter((draft) => draft.projectId === 'project/one'),
    ).toHaveLength(2);
    deleteDraft(empty.id);
    deleteDraft(invested.id);
  });

  it('reads fresh metadata before updating and persists the bounded title', () => {
    installStorage();
    const first = createDraft('fresh-project', 'worktree', 123);
    const external = {
      id: 'external-draft',
      projectId: 'fresh-project',
      createdAt: 124,
      updatedAt: 124,
      isolation: 'main',
    };
    values.set(
      'pi-dashboard-drafts:v1',
      JSON.stringify([...readDrafts(), external]),
    );
    updateDraft(first.id, 'A derived title');
    expect(readDrafts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'external-draft' }),
        expect.objectContaining({ id: first.id, title: 'A derived title' }),
      ]),
    );
  });

  it('provides stable encoded navigation and promotion identities', () => {
    expect(draftPath('draft/one')).toBe('/drafts/draft%2Fone');
    expect(draftPromotionCommandId('draft-1')).toBe('draft-promote-draft-1');
    const draft = createDraft('project-1', 'worktree', 123);
    expect(draft).toMatchObject({
      projectId: 'project-1',
      createdAt: 123,
      updatedAt: 123,
      isolation: 'worktree',
    });
  });
});
