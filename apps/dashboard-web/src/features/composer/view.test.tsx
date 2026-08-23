import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mutateAsync = vi.fn(async () => ({ result: { runtimeId: 'runtime-1' } }));
const sendCommandWithImages = vi.fn(async () => undefined);
const clearDraft = vi.fn();
const clearAttachments = vi.fn();
let mockedAttachments: readonly { file: File; previewUrl: string }[] = [];

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ isPending: false, mutateAsync }),
  useQuery: () => ({ data: { commands: [] } }),
}));
vi.mock('@pi-dashboard/client', () => ({
  commandMutationOptions: vi.fn(),
  composerCommandsQueryOptions: vi.fn(),
  dashboardHttpClient: { sendCommandWithImages },
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
    attachments: mockedAttachments,
    dragging: false,
    fileInputRef: { current: null },
    selectImages: vi.fn(),
    removeImage: vi.fn(),
    clearAttachments,
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
      {props.mode as never}
      {props.controls as never}
      {props.footer as never}
    </div>
  ),
}));

afterEach(() => {
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({ result: { runtimeId: 'runtime-1' } });
  sendCommandWithImages.mockClear();
  clearDraft.mockClear();
  clearAttachments.mockClear();
  mockedAttachments = [];
});

describe('Composer dormant resume transition', () => {
  it('does not reassert pending after runtime registration wins the race', async () => {
    let resolveStart!: (value: { result: { runtimeId: string } }) => void;
    mutateAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    const { Composer } = await import('./view');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <Composer
          runtime={undefined}
          sessionId="session-1"
          projectId="project-1"
          checkoutId="checkout-1"
        />,
      );
    });
    await act(async () => {
      renderer.root.findByProps({ children: 'Send' }).props.onClick();
      await Promise.resolve();
    });
    const runtime = {
      runtimeId: 'runtime-1',
      liveState: 'idle',
      online: true,
      model: { provider: 'test', model: 'text' },
      session: { id: 'session-1', entries: [] },
    } as unknown as RuntimeSnapshot;
    await act(async () => {
      renderer.update(
        <Composer
          runtime={runtime}
          sessionId="session-1"
          projectId="project-1"
          checkoutId="checkout-1"
        />,
      );
      resolveStart({ result: { runtimeId: 'runtime-1' } });
      await Promise.resolve();
    });
    expect(renderer.root.findByType('div').props['data-attachments-busy']).toBe(
      'false',
    );
  });

  it('clears pending state when the started runtime arrives', async () => {
    const { Composer } = await import('./view');
    const dormant = (
      <Composer
        runtime={undefined}
        sessionId="session-1"
        projectId="project-1"
        checkoutId="checkout-1"
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
      projectId: 'project-1',
      checkoutId: 'checkout-1',
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
          projectId="project-1"
          checkoutId="checkout-1"
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

  it('uses active-style controls and launches with dormant selections', async () => {
    const runtime = {
      runtimeId: 'runtime-catalog',
      liveState: 'idle',
      online: true,
      model: { provider: 'test', model: 'careful', thinking: 'low' },
      modelCatalog: [
        { provider: 'test', model: 'careful', name: 'Careful' },
        { provider: 'test', model: 'fast', name: 'Fast' },
      ],
      thinkingLevels: ['low', 'high'],
      contextUsage: { tokens: 80, contextWindow: 100, percent: 80 },
      session: { id: 'other-session', entries: [] },
    } as unknown as RuntimeSnapshot;
    const { Composer } = await import('./view');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <Composer
          runtime={undefined}
          runtimes={[runtime]}
          session={{
            id: 'session-1',
            file: '',
            cwd: '/tmp',
            updatedAt: 1,
            lastKnownModel: { provider: 'test', model: 'careful' },
            lastKnownThinking: 'low',
            lastKnownContextTokens: 42,
          }}
          sessionId="session-1"
          projectId="project-1"
          checkoutId="checkout-1"
        />,
      );
    });

    expect(renderer.root.findByProps({ 'aria-label': 'Model' })).toBeTruthy();
    expect(
      renderer.root.findByProps({ 'aria-label': 'Thinking level' }),
    ).toBeTruthy();
    expect(
      renderer.root.findByProps({
        'aria-label': 'Context window 42% [42/100]',
      }),
    ).toBeTruthy();
    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Model' })
        .props.onChange({ target: { value: 'test/fast' } });
      renderer.root
        .findByProps({ 'aria-label': 'Thinking level' })
        .props.onChange({ target: { value: 'high' } });
    });
    await act(async () => {
      renderer.root.findByProps({ children: 'Send' }).props.onClick();
      await Promise.resolve();
    });
    expect(mutateAsync).toHaveBeenCalledWith({
      projectId: 'project-1',
      checkoutId: 'checkout-1',
      sessionId: 'session-1',
      initialPrompt: 'resume me',
      model: { provider: 'test', model: 'fast', thinking: 'high' },
    });
  });

  it('starts dormant image resumes without initialPrompt and sends once', async () => {
    mockedAttachments = [
      { file: { name: 'image.png' } as File, previewUrl: 'preview' },
    ];
    const runtime = {
      runtimeId: 'runtime-1',
      liveState: 'idle',
      online: true,
      model: { provider: 'test', model: 'vision', supportsImages: true },
      session: { id: 'session-1', entries: [] },
    } as unknown as RuntimeSnapshot;
    const store = {
      getSnapshot: () => ({ runtimesById: { 'runtime-1': runtime } }),
      subscribe: vi.fn(),
    } as never;
    const { Composer } = await import('./view');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <Composer
          runtime={undefined}
          runtimes={[runtime]}
          session={{
            id: 'session-1',
            file: '',
            cwd: '/tmp',
            updatedAt: 1,
            lastKnownModel: { provider: 'test', model: 'vision' },
          }}
          store={store}
          sessionId="session-1"
          projectId="project-1"
          checkoutId="checkout-1"
        />,
      );
    });
    expect(
      renderer.root.findByProps({ children: 'Attach' }).props.disabled,
    ).toBe(false);
    await act(async () => {
      renderer.root.findByProps({ children: 'Send' }).props.onClick();
      await Promise.resolve();
    });
    expect(mutateAsync).toHaveBeenCalledWith({
      projectId: 'project-1',
      checkoutId: 'checkout-1',
      sessionId: 'session-1',
      model: { provider: 'test', model: 'vision' },
    });
    expect(sendCommandWithImages).toHaveBeenCalledOnce();
    expect(clearAttachments).toHaveBeenCalledOnce();
    expect(clearDraft).toHaveBeenCalledOnce();
  });

  it('preserves dormant images when capability or delivery fails', async () => {
    mockedAttachments = [
      { file: { name: 'image.png' } as File, previewUrl: 'preview' },
    ];
    const runtime = {
      runtimeId: 'runtime-1',
      liveState: 'idle',
      online: true,
      model: { provider: 'test', model: 'vision', supportsImages: true },
      session: { id: 'session-1', entries: [] },
    } as unknown as RuntimeSnapshot;
    const startedRuntime = {
      ...runtime,
      model: { provider: 'test', model: 'vision', supportsImages: false },
    } as unknown as RuntimeSnapshot;
    const store = {
      getSnapshot: () => ({ runtimesById: { 'runtime-1': startedRuntime } }),
      subscribe: vi.fn(),
    } as never;
    const { Composer } = await import('./view');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <Composer
          runtime={undefined}
          runtimes={[runtime]}
          session={{
            id: 'session-1',
            file: '',
            cwd: '/tmp',
            updatedAt: 1,
            lastKnownModel: { provider: 'test', model: 'vision' },
          }}
          store={store}
          sessionId="session-1"
          projectId="project-1"
          checkoutId="checkout-1"
        />,
      );
    });
    await act(async () => {
      renderer.root.findByProps({ children: 'Send' }).props.onClick();
      await Promise.resolve();
    });
    expect(sendCommandWithImages).not.toHaveBeenCalled();
    expect(clearAttachments).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();

    startedRuntime.model = {
      provider: 'test',
      model: 'vision',
      supportsImages: true,
    };
    sendCommandWithImages.mockRejectedValueOnce(new Error('send failed'));
    await act(async () => {
      renderer.root.findByProps({ children: 'Send' }).props.onClick();
      await Promise.resolve();
    });
    expect(sendCommandWithImages).toHaveBeenCalledOnce();
    expect(clearAttachments).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
  });
});
