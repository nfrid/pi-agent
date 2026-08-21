import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mutateAsync = vi.fn(async () => ({ result: { runtimeId: 'runtime-1' } }));
const clearDraft = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ isPending: false, mutateAsync }),
  useQuery: () => ({ data: { commands: [] } }),
}));
vi.mock('@pi-dashboard/client', () => ({
  commandMutationOptions: vi.fn(),
  composerCommandsQueryOptions: vi.fn(),
  dashboardHttpClient: {},
  startRuntimeMutationOptions: vi.fn(),
}));
vi.mock('../../routes/navigation', () => ({
  useDashboardNavigate: () => vi.fn(),
}));
vi.mock('./draft', () => ({
  useComposerDraft: () => ({
    initialDraft: 'resume me',
    text: 'resume me',
    updateText: vi.fn(),
    clearDraft,
  }),
}));
vi.mock('./attachments', () => ({
  useImageAttachments: () => ({
    attachments: [],
    dragging: false,
    fileInputRef: { current: null },
    selectImages: vi.fn(),
    removeImage: vi.fn(),
    clearAttachments: vi.fn(),
    onDragEnter: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    onPasteCapture: vi.fn(),
  }),
}));
vi.mock('./queue', () => ({
  newQueueId: () => 'queue-1',
  QueuePanel: () => null,
  queueCommand: vi.fn(),
  shouldShowQueuePanel: () => false,
  useComposerQueue: () => ({
    queue: [],
    setQueue: vi.fn(),
    addOptimistic: vi.fn(),
    rejectOptimistic: vi.fn(),
  }),
}));
vi.mock('./runtime-controls', () => ({
  RuntimeModelControl: () => null,
  RuntimeThinkingControl: () => null,
}));
vi.mock('./shell', () => ({
  ComposerShell: (props: Record<string, unknown>) => (
    <div
      data-send-disabled={String(props.sendDisabled)}
      data-attachments-enabled={String(props.attachmentsEnabled)}
      data-attachments-busy={String(props.attachmentsBusy)}
    >
      <button
        type="button"
        disabled={Boolean(props.sendDisabled)}
        onClick={() => {
          const event = { preventDefault: vi.fn() };
          void (
            props.onSubmit as (event: { preventDefault: () => void }) => void
          )(event);
        }}
      >
        Send
      </button>
      <button
        type="button"
        disabled={!props.attachmentsEnabled || Boolean(props.attachmentsBusy)}
      >
        Attach
      </button>
    </div>
  ),
}));

afterEach(() => {
  mutateAsync.mockClear();
  clearDraft.mockClear();
});

describe('Composer dormant resume transition', () => {
  it('clears pending state when the started runtime arrives', async () => {
    const { Composer } = await import('./view');
    const dormant = (
      <Composer
        runtime={undefined}
        sessionId="session-1"
        workspaceId="workspace-1"
      />
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(dormant);
    });

    const send = renderer.root.findByProps({ children: 'Send' });
    await act(async () => {
      send.props.onClick();
      await Promise.resolve();
    });
    expect(mutateAsync).toHaveBeenCalledOnce();
    expect(mutateAsync).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      initialPrompt: 'resume me',
    });
    expect(clearDraft).toHaveBeenCalledOnce();

    const runtime = {
      runtimeId: 'runtime-1',
      liveState: 'idle',
      online: true,
      model: { provider: 'test', model: 'vision', supportsImages: true },
      session: { id: 'session-1', entries: [] },
    } as unknown as RuntimeSnapshot;
    await act(async () => {
      renderer.update(
        <Composer
          runtime={runtime}
          sessionId="session-1"
          workspaceId="workspace-1"
        />,
      );
    });

    const shell = renderer.root.findByType('div');
    expect(shell.props['data-attachments-busy']).toBe('false');
    expect(shell.props['data-attachments-enabled']).toBe('true');
    expect(
      renderer.root.findByProps({ children: 'Attach' }).props.disabled,
    ).toBe(false);
  });
});
