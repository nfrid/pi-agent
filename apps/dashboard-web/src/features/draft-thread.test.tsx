import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mutateAsync,
  go,
  deleteDraft,
  markDraftPromoted,
  beginDraftRetry,
  setDraftModel,
  clearDraft,
  draft,
} = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  go: vi.fn(),
  deleteDraft: vi.fn(),
  markDraftPromoted: vi.fn(),
  beginDraftRetry: vi.fn(),
  setDraftModel: vi.fn(),
  clearDraft: vi.fn(),
  draft: {
    id: 'draft-1',
    projectId: 'project-1',
    createdAt: 1,
    updatedAt: 1,
    isolation: 'worktree' as const,
    promotedThreadId: undefined as string | undefined,
    model: undefined as
      | { provider: string; model: string; thinking?: string }
      | undefined,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ isPending: false, mutateAsync }),
}));
vi.mock('@pi-dashboard/client', () => ({
  createThreadMutationOptions: vi.fn(() => ({})),
  retryThreadMutationOptions: vi.fn(() => ({})),
  dashboardHttpClient: {},
}));
vi.mock('../routes/navigation', () => ({
  useDashboardNavigate: () => go,
}));
vi.mock('./agent-thread-nav', () => ({ AgentThreadNav: () => null }));
vi.mock('./composer/attachments', () => ({
  useImageAttachments: () => ({
    attachments: [],
    dragging: false,
    fileInputRef: { current: null },
    selectImages: vi.fn(),
    removeImage: vi.fn(),
    onDragEnter: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    onPasteCapture: vi.fn(),
  }),
}));
vi.mock('./composer/draft', () => ({
  useComposerDraft: () => ({
    initialDraft: 'Do the thing',
    text: 'Do the thing',
    updateText: vi.fn(),
    clearDraft,
  }),
}));
vi.mock('./composer/shell', () => ({
  ComposerShell: (props: { onSubmit: (event: unknown) => void }) => (
    <form onSubmit={props.onSubmit} />
  ),
}));
vi.mock('./drafts', () => ({
  beginDraftRetry,
  deleteDraft,
  draftPromotionCommandId: (id: string) => `draft-promote-${id}`,
  draftRetryCommandId: (id: string, attempt: number) =>
    `draft-retry-${id}-${attempt}`,
  markDraftPromoted,
  readDrafts: () => [draft],
  setDraftModel,
  updateDraft: vi.fn(),
  useDrafts: () => [draft],
}));

import {
  DraftThreadView,
  draftModelSelection,
  draftThinkingLevels,
} from './draft-thread';

const snapshot = {
  projects: [{ id: 'project-1', title: 'Project One', rootPath: '/work/one' }],
  runtimes: [],
} as never;

afterEach(() => {
  mutateAsync.mockReset();
  go.mockReset();
  deleteDraft.mockReset();
  markDraftPromoted.mockReset();
  beginDraftRetry.mockReset();
  setDraftModel.mockReset();
  clearDraft.mockReset();
  vi.unstubAllGlobals();
  draft.promotedThreadId = undefined;
  draft.model = undefined;
});

describe('draft thread controls', () => {
  it('chooses a configured current model and exposes effort levels', () => {
    const runtimes = [
      {
        model: { provider: 'test', model: 'fast', thinking: 'high' },
        modelCatalog: [
          { provider: 'test', model: 'fast', name: 'Fast' },
          { provider: 'test', model: 'careful', name: 'Careful' },
        ],
        thinkingLevels: ['off', 'low', 'high'],
      },
    ] as never;
    expect(draftModelSelection(runtimes)).toEqual({
      provider: 'test',
      model: 'fast',
      thinking: 'high',
    });
    expect(draftThinkingLevels(runtimes)).toEqual(['off', 'low', 'high']);
  });

  it('deletes the draft after confirmation and replaces navigation', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DraftThreadView draftId="draft-1" snapshot={snapshot} />,
      );
    });
    const button = renderer.root
      .findAllByType('button')
      .find((candidate) => candidate.props.children === 'Delete draft');
    if (!button) throw new Error('delete button not found');
    await act(async () => button.props.onClick());
    expect(clearDraft).toHaveBeenCalledOnce();
    expect(deleteDraft).toHaveBeenCalledWith('draft-1');
    expect(go).toHaveBeenCalledWith('/projects/project-1', { replace: true });
    renderer.unmount();
  });
});

describe('draft thread promotion', () => {
  it('uses a stable command and retains the draft after accepted creation', async () => {
    mutateAsync.mockResolvedValue({ thread: { id: 'thread-1' } });
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DraftThreadView draftId="draft-1" snapshot={snapshot} />,
      );
    });
    const form = renderer.root.findByType('form');

    await act(async () => {
      await form.props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(mutateAsync).toHaveBeenCalledWith({
      projectId: 'project-1',
      command: {
        commandId: 'draft-promote-draft-1',
        title: 'Do the thing',
        prompt: 'Do the thing',
        isolation: 'worktree',
      },
    });
    expect(markDraftPromoted).toHaveBeenCalledWith('draft-1', 'thread-1');
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledWith('/drafts/draft-1/pending/thread-1', {
      replace: true,
    });
    renderer.unmount();
  });

  it('passes the selected model and effort into thread creation', async () => {
    mutateAsync.mockResolvedValue({ thread: { id: 'thread-1' } });
    const modelSnapshot = {
      projects: [
        { id: 'project-1', title: 'Project One', rootPath: '/work/one' },
      ],
      runtimes: [
        {
          model: { provider: 'test', model: 'fast', thinking: 'high' },
          modelCatalog: [{ provider: 'test', model: 'fast', name: 'Fast' }],
          thinkingLevels: ['off', 'high'],
        },
      ],
    } as never;
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DraftThreadView draftId="draft-1" snapshot={modelSnapshot} />,
      );
    });
    const form = renderer.root.findByType('form');

    await act(async () => {
      await form.props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          model: { provider: 'test', model: 'fast', thinking: 'high' },
        }),
      }),
    );
    renderer.unmount();
  });

  it('retries a promoted draft instead of creating another thread', async () => {
    draft.promotedThreadId = 'thread-existing';
    beginDraftRetry.mockReturnValue({
      threadId: 'thread-existing',
      attempt: 1,
      commandId: 'draft-retry-draft-1-1',
    });
    mutateAsync.mockResolvedValue({ run: { id: 'run-1' } });
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DraftThreadView draftId="draft-1" snapshot={snapshot} />,
      );
    });
    const form = renderer.root.findByType('form');

    await act(async () => {
      await form.props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(beginDraftRetry).toHaveBeenCalledWith('draft-1');
    expect(mutateAsync).toHaveBeenCalledWith({
      threadId: 'thread-existing',
      command: { commandId: 'draft-retry-draft-1-1', prompt: 'Do the thing' },
    });
    expect(go).toHaveBeenCalledWith('/drafts/draft-1/pending/thread-existing', {
      replace: true,
    });
    renderer.unmount();
  });

  it('keeps the draft on promotion failure', async () => {
    mutateAsync.mockRejectedValue(new Error('startup unavailable'));
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DraftThreadView draftId="draft-1" snapshot={snapshot} />,
      );
    });
    const form = renderer.root.findByType('form');

    await act(async () => {
      await form.props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(deleteDraft).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    renderer.unmount();
  });
});
