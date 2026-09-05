import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const draftDefaultState = vi.hoisted(() => ({
  selection: undefined as
    | {
        provider: string;
        model: string;
        thinking?: string;
        serviceTier?: 'fast' | 'ultrafast';
      }
    | undefined,
  ready: true,
}));

const {
  mutateAsync,
  go,
  deleteDraft,
  markDraftPromoted,
  beginDraftRetry,
  clearDraft,
  clearAttachments,
  createThreadWithImages,
  retryThreadWithImages,
  imageAttachments,
  draft,
} = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  go: vi.fn(),
  deleteDraft: vi.fn(),
  markDraftPromoted: vi.fn(),
  beginDraftRetry: vi.fn(),
  clearDraft: vi.fn(),
  clearAttachments: vi.fn(),
  createThreadWithImages: vi.fn(),
  retryThreadWithImages: vi.fn(),
  imageAttachments: [] as Array<{ file: File; previewUrl: string }>,
  draft: {
    id: 'draft-1',
    projectId: 'project-1',
    createdAt: 1,
    updatedAt: 1,
    isolation: 'worktree' as const,
    location: undefined as
      | { kind: 'current' }
      | { kind: 'worktree'; base: 'work' | 'head' }
      | { kind: 'worktree'; base: 'branch'; baseRef: string }
      | { kind: 'checkout'; checkoutId: string }
      | undefined,
    promotedThreadId: undefined as string | undefined,
    model: undefined as
      | {
          provider: string;
          model: string;
          thinking?: string;
          serviceTier?: 'fast' | 'ultrafast';
        }
      | undefined,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ isPending: false, mutateAsync }),
  useQuery: (options: { draftDefaultsQuery?: boolean }) =>
    options.draftDefaultsQuery
      ? {
          data: draftDefaultState.selection
            ? { selection: draftDefaultState.selection }
            : {},
          isSuccess: draftDefaultState.ready,
        }
      : { data: { commands: [] } },
}));
vi.mock('@pi-dashboard/client', () => ({
  composerCommandsQueryOptions: vi.fn(() => ({})),
  draftDefaultsQueryOptions: vi.fn(() => ({ draftDefaultsQuery: true })),
  createThreadMutationOptions: vi.fn(() => ({})),
  retryThreadMutationOptions: vi.fn(() => ({})),
  dashboardHttpClient: { createThreadWithImages, retryThreadWithImages },
}));
vi.mock('../routes/navigation', () => ({
  useDashboardNavigate: () => go,
}));
vi.mock('./agent-thread-nav', () => ({ AgentThreadNav: () => null }));
vi.mock('./composer/attachments', () => ({
  useImageAttachments: () => ({
    attachments: imageAttachments,
    dragging: false,
    fileInputRef: { current: null },
    selectImages: vi.fn(),
    removeImage: vi.fn(),
    onDragEnter: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    onPasteCapture: vi.fn(),
    clearAttachments,
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
  ComposerShell: (props: {
    onSubmit: (event: unknown) => void;
    sendDisabled?: boolean;
    attachmentsEnabled?: boolean;
  }) => (
    <form
      onSubmit={props.onSubmit}
      data-send-disabled={props.sendDisabled ? 'true' : 'false'}
      data-attachments-enabled={props.attachmentsEnabled ? 'true' : 'false'}
    />
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
  updateDraft: vi.fn(),
  useDrafts: () => [draft],
}));

import { DraftThreadView, draftModelSelection } from './draft-thread';

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
  clearDraft.mockReset();
  clearAttachments.mockReset();
  createThreadWithImages.mockReset();
  retryThreadWithImages.mockReset();
  imageAttachments.splice(0);
  vi.unstubAllGlobals();
  draft.location = undefined;
  draft.promotedThreadId = undefined;
  draft.model = undefined;
  draftDefaultState.selection = undefined;
  draftDefaultState.ready = true;
});

function paragraphText(renderer: ReturnType<typeof create>): string[] {
  return renderer.root
    .findAllByType('p')
    .map((paragraph) =>
      paragraph.children.filter((child) => typeof child === 'string').join(''),
    );
}

describe('draft thread controls', () => {
  it('shows stage-specific preparing startup feedback and an accessible spinner', async () => {
    draft.promotedThreadId = 'thread-1';
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DraftThreadView
          draftId="draft-1"
          snapshot={
            {
              projects: [
                {
                  id: 'project-1',
                  title: 'Project One',
                  rootPath: '/work/one',
                },
              ],
              runtimes: [],
              runs: [
                {
                  threadId: 'thread-1',
                  attempt: 1,
                  createdAt: 10,
                  status: 'preparing',
                },
              ],
            } as never
          }
        />,
      );
    });
    expect(paragraphText(renderer)).toContain('Preparing worktree');
    expect(paragraphText(renderer)).toContain(
      'Creating the isolated checkout for this thread…',
    );
    const spinners = renderer.root.findAll(
      (node) => node.props.className === 'session-loading-indicator',
    );
    expect(spinners).toHaveLength(1);
    expect(['true', true]).toContain(spinners[0]?.props['aria-hidden']);
    const status = renderer.root.findByProps({ role: 'status' });
    expect(status.props['aria-live']).toBe('polite');
    expect(status.props['aria-atomic']).toBe('true');
    renderer.unmount();
  });

  it('shows launching copy for starting and scheduling copy before a run snapshot', async () => {
    draft.promotedThreadId = 'thread-1';
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DraftThreadView
          draftId="draft-1"
          snapshot={
            {
              projects: [
                {
                  id: 'project-1',
                  title: 'Project One',
                  rootPath: '/work/one',
                },
              ],
              runtimes: [],
              runs: [
                {
                  threadId: 'thread-1',
                  attempt: 1,
                  createdAt: 10,
                  status: 'starting',
                },
              ],
            } as never
          }
        />,
      );
    });
    expect(paragraphText(renderer)).toContain('Launching Pi');
    expect(paragraphText(renderer)).toContain(
      'Launching Pi runtime and waiting for connection…',
    );
    renderer.unmount();

    mutateAsync.mockReturnValue(new Promise(() => {}));
    draft.promotedThreadId = undefined;
    await act(async () => {
      renderer = create(
        <DraftThreadView draftId="draft-1" snapshot={snapshot} />,
      );
    });
    await act(async () => {
      void renderer.root.findByType('form').props.onSubmit({
        preventDefault: vi.fn(),
      });
    });
    expect(paragraphText(renderer)).toContain('Scheduling thread');
    expect(paragraphText(renderer)).toContain('Scheduling thread…');
    renderer.unmount();
  });
  it('uses the inherited tuple supplied by the server', () => {
    expect(
      draftModelSelection(
        [
          {
            model: { provider: 'test', model: 'first', thinking: 'low' },
            modelCatalog: [
              { provider: 'test', model: 'first' },
              { provider: 'test', model: 'default' },
            ],
          },
        ] as never,
        undefined,
        { provider: 'test', model: 'default', thinking: 'high' },
      ),
    ).toEqual({ provider: 'test', model: 'default', thinking: 'high' });
  });

  it('preserves an explicit draft tuple without runtime reconciliation', () => {
    const runtimes = [
      {
        model: { provider: 'test', model: 'sol', thinking: 'medium' },
        modelCatalog: [
          { provider: 'test', model: 'spark' },
          { provider: 'test', model: 'sol' },
        ],
      },
    ] as never;
    expect(
      draftModelSelection(runtimes, { provider: 'test', model: 'spark' }),
    ).toEqual({ provider: 'test', model: 'spark' });
    expect(
      draftModelSelection(runtimes, {
        provider: 'test',
        model: 'spark',
        thinking: 'low',
      }),
    ).toEqual({ provider: 'test', model: 'spark', thinking: 'low' });
  });

  it('returns no model without an explicit or inherited tuple', () => {
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
    expect(draftModelSelection(runtimes)).toBeUndefined();
  });

  it('shows startup in place and only transitions when the runtime appears', async () => {
    draft.promotedThreadId = 'thread-1';
    const pendingSnapshot = {
      projects: [
        { id: 'project-1', title: 'Project One', rootPath: '/work/one' },
      ],
      runtimes: [],
      runs: [
        {
          threadId: 'thread-1',
          runtimeId: 'runtime-1',
          attempt: 1,
          createdAt: 10,
          status: 'starting',
        },
      ],
    } as never;
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DraftThreadView draftId="draft-1" snapshot={pendingSnapshot} />,
      );
    });
    expect(
      renderer.root
        .findAllByType('span')
        .some((node) => node.children.some((child) => child === 'starting')),
    ).toBe(true);
    expect(go).not.toHaveBeenCalled();

    await act(async () => {
      renderer.update(
        <DraftThreadView
          draftId="draft-1"
          snapshot={
            {
              projects: [
                {
                  id: 'project-1',
                  title: 'Project One',
                  rootPath: '/work/one',
                },
              ],
              runs: [
                {
                  threadId: 'thread-1',
                  runtimeId: 'runtime-1',
                  attempt: 1,
                  createdAt: 10,
                  status: 'starting',
                },
              ],
              runtimes: [
                {
                  runtimeId: 'runtime-1',
                  session: { id: 'session-1', entries: [] },
                },
              ],
            } as never
          }
        />,
      );
    });
    expect(clearDraft).toHaveBeenCalledOnce();
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledWith('/sessions/session-1', { replace: true });
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
    expect(go).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('disables send and images while inherited defaults are unresolved', async () => {
    draftDefaultState.ready = false;
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DraftThreadView draftId="draft-1" snapshot={snapshot} />,
      );
    });
    const form = renderer.root.findByType('form');
    expect(form.props['data-send-disabled']).toBe('true');
    expect(form.props['data-attachments-enabled']).toBe('false');
    renderer.unmount();
  });

  it('pins the displayed inherited tuple into thread creation', async () => {
    draftDefaultState.selection = {
      provider: 'openai-codex',
      model: 'gpt-5',
      thinking: 'high',
      serviceTier: 'fast',
    };
    mutateAsync.mockResolvedValue({ thread: { id: 'thread-inherited' } });
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DraftThreadView draftId="draft-1" snapshot={snapshot} />,
      );
    });
    const form = renderer.root.findByType('form');
    expect(form.props['data-send-disabled']).toBe('false');
    await act(async () => {
      await form.props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          model: {
            provider: 'openai-codex',
            model: 'gpt-5',
            thinking: 'high',
            serviceTier: 'fast',
          },
        }),
      }),
    );
    renderer.unmount();
  });

  it('uses the project current checkout by default', async () => {
    draft.location = { kind: 'current' };
    mutateAsync.mockResolvedValue({ thread: { id: 'thread-1' } });
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DraftThreadView
          draftId="draft-1"
          snapshot={
            {
              projects: [
                {
                  id: 'project-1',
                  title: 'Project One',
                  rootPath: '/work/one',
                },
              ],
              runtimes: [],
              checkouts: [
                {
                  id: 'checkout-main',
                  projectId: 'project-1',
                  kind: 'main',
                  path: '/work/one',
                  status: 'ready',
                  updatedAt: 1,
                },
              ],
            } as never
          }
        />,
      );
    });

    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({
        preventDefault: vi.fn(),
      });
    });

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ checkoutId: 'checkout-main' }),
      }),
    );
    expect(mutateAsync.mock.calls[0]?.[0].command).not.toHaveProperty(
      'isolation',
    );
    renderer.unmount();
  });

  it('passes a selected branch as a new worktree base', async () => {
    draft.location = {
      kind: 'worktree',
      base: 'branch',
      baseRef: 'develop',
    };
    mutateAsync.mockResolvedValue({ thread: { id: 'thread-1' } });
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DraftThreadView draftId="draft-1" snapshot={snapshot} />,
      );
    });

    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({
        preventDefault: vi.fn(),
      });
    });

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          isolation: 'worktree',
          baseRef: 'develop',
        }),
      }),
    );
    renderer.unmount();
  });

  it('passes the explicit draft model and effort into thread creation', async () => {
    draft.model = { provider: 'test', model: 'fast', thinking: 'high' };
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

  it('creates a draft thread with selected images through multipart upload', async () => {
    const file = { name: 'draft.png' } as File;
    imageAttachments.push({ file, previewUrl: 'blob:draft' });
    createThreadWithImages.mockResolvedValue({
      thread: { id: 'thread-image' },
    });
    const imageSnapshot = {
      projects: [
        { id: 'project-1', title: 'Project One', rootPath: '/work/one' },
      ],
      runtimes: [
        {
          model: { provider: 'test', model: 'vision', supportsImages: true },
          modelCatalog: [
            { provider: 'test', model: 'vision', supportsImages: true },
          ],
        },
      ],
    } as never;
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DraftThreadView draftId="draft-1" snapshot={imageSnapshot} />,
      );
    });

    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({
        preventDefault: vi.fn(),
      });
    });

    expect(createThreadWithImages).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        commandId: 'draft-promote-draft-1',
        prompt: 'Do the thing',
      }),
      [file],
    );
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(clearAttachments).toHaveBeenCalledOnce();
    expect(markDraftPromoted).toHaveBeenCalledWith('draft-1', 'thread-image');
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
    expect(go).not.toHaveBeenCalled();
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
