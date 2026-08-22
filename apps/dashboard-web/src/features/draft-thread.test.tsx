import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mutateAsync, go, deleteDraft, draft } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  go: vi.fn(),
  deleteDraft: vi.fn(),
  draft: {
    id: 'draft-1',
    projectId: 'project-1',
    createdAt: 1,
    updatedAt: 1,
    isolation: 'worktree' as const,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ isPending: false, mutateAsync }),
}));
vi.mock('@pi-dashboard/client', () => ({
  createThreadMutationOptions: vi.fn(() => ({})),
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
  }),
}));
vi.mock('./composer/shell', () => ({
  ComposerShell: (props: { onSubmit: (event: unknown) => void }) => (
    <form onSubmit={props.onSubmit} />
  ),
}));
vi.mock('./drafts', () => ({
  deleteDraft,
  draftPromotionCommandId: (id: string) => `draft-promote-${id}`,
  readDrafts: () => [draft],
  updateDraft: vi.fn(),
  useDrafts: () => [draft],
}));

import { DraftThreadView } from './draft-thread';

const snapshot = {
  projects: [{ id: 'project-1', title: 'Project One', rootPath: '/work/one' }],
} as never;

afterEach(() => {
  mutateAsync.mockReset();
  go.mockReset();
  deleteDraft.mockReset();
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
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledWith('/drafts/draft-1/pending/thread-1');
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
