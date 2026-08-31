import type { SessionBranchPoint } from '@pi-dashboard/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { TranscriptModelItem } from '../../transcript';

const sessionImage = vi.hoisted(() => vi.fn());
vi.mock('@pi-dashboard/client', () => ({
  dashboardHttpClient: { sessionImage },
}));

import { TranscriptEntry } from './entries';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

describe('transcript entries', () => {
  it('renders unresolved live assistant text in full instead of a preparing event', () => {
    const item: TranscriptModelItem = {
      key: 'assistant-live',
      raw: {},
      entry: { kind: 'assistant', speaks: true, streaming: true },
      role: 'assistant',
      text: 'Editing the shutdown path.\n\nThis needs a guarded cleanup.',
      preparing: true,
    };

    const markup = renderToStaticMarkup(<TranscriptEntry item={item} />);

    expect(markup).toContain('message-bubble message-assistant');
    expect(markup).toContain('Editing the shutdown path.');
    expect(markup).toContain('This needs a guarded cleanup.');
    expect(markup).not.toContain('preparing-toolcall');
    expect(markup).not.toContain('preparing tool call');
  });

  it('shows a path indicator only for user bubbles with multiple immediate paths', () => {
    const item: TranscriptModelItem = {
      key: 'path-a',
      raw: {},
      entry: { kind: 'other' },
      role: 'user',
      text: 'Choose a direction',
    };
    const point: SessionBranchPoint = {
      id: 'root-user',
      memberIds: ['path-a', 'path-b'],
      paths: [
        { id: 'path-a', label: 'Try A', current: true },
        { id: 'path-b', label: 'Try B', current: false },
      ],
    };
    const branched = renderToStaticMarkup(
      <TranscriptEntry
        item={item}
        branchPoint={point}
        onOpenBranchPaths={() => undefined}
      />,
    );
    expect(branched).toContain('transcript-branch-indicator');
    expect(branched).toContain('Show 2 paths from this message');
    expect(
      renderToStaticMarkup(
        <TranscriptEntry
          item={item}
          branchPoint={{ ...point, paths: point.paths.slice(0, 1) }}
        />,
      ),
    ).not.toContain('transcript-branch-indicator');
  });

  it('shows short thinking directly and collapses only longer thinking sequences', () => {
    const item = (thinking: string[]): TranscriptModelItem => ({
      key: `assistant-thinking-${thinking.length}`,
      raw: {},
      entry: { kind: 'assistant', speaks: false },
      role: 'assistant',
      thinking,
    });
    const short = renderToStaticMarkup(
      <TranscriptEntry item={item(['one', 'two', 'three'])} />,
    );
    expect(short).not.toContain('transcript-thinking"');
    expect(short).toContain('one');
    expect(short).toContain('three');

    const long = renderToStaticMarkup(
      <TranscriptEntry item={item(['one', 'two', 'three', 'four'])} />,
    );
    expect(long).toContain('Show 1 earlier item');
    expect(long).not.toContain('>one<');
    expect(long).toContain('four');
  });

  it('copies the raw assistant Markdown and confirms the action', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const text = '**Copied heading**\n\n- first\n- second';
    const item: TranscriptModelItem = {
      key: 'assistant-copy',
      raw: {},
      entry: { kind: 'assistant', speaks: true },
      role: 'assistant',
      text,
    };
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TranscriptEntry item={item} />);
    });
    const button = tree.root.findByProps({
      'aria-label': 'Copy assistant message',
    });
    await act(async () => button.props.onClick());

    expect(writeText).toHaveBeenCalledWith(text);
    expect(
      tree.root.findByProps({ 'aria-label': 'Copied assistant message' }),
    ).toBeDefined();
    act(() => tree.unmount());
  });

  it('shows a loading thumbnail before fetching the full image on demand', async () => {
    sessionImage.mockClear();
    let resolveThumbnail!: (blob: Blob) => void;
    sessionImage
      .mockReturnValueOnce(
        new Promise<Blob>((resolve) => {
          resolveThumbnail = resolve;
        }),
      )
      .mockResolvedValueOnce(new Blob(['full'], { type: 'image/png' }));
    const createObjectURL = vi
      .fn()
      .mockReturnValueOnce('blob:thumbnail')
      .mockReturnValueOnce('blob:full');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const dialog = {
      open: false,
      showModal: vi.fn(function (this: { open: boolean }) {
        this.open = true;
      }),
      close: vi.fn(function (this: { open: boolean }) {
        this.open = false;
      }),
    };
    const item: TranscriptModelItem = {
      key: 'user-image-entry',
      sessionId: 'session-1',
      raw: { type: 'message', message: { timestamp: 12345 } },
      entry: { kind: 'other' },
      role: 'user',
      imageCount: 1,
      images: [{ index: 0, mimeType: 'image/png', available: true }],
    };
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TranscriptEntry item={item} />, {
        createNodeMock: (element) => (element.type === 'dialog' ? dialog : {}),
      });
    });
    expect(
      tree.root.findByProps({ 'aria-label': 'Loading attachment 1' }).props[
        'aria-busy'
      ],
    ).toBe(true);

    await act(async () => {
      resolveThumbnail(new Blob(['thumbnail'], { type: 'image/webp' }));
      await Promise.resolve();
    });
    expect(sessionImage).toHaveBeenNthCalledWith(
      1,
      'session-1',
      'user-image-entry',
      0,
      expect.objectContaining({
        variant: 'thumbnail',
        messageTimestamp: 12345,
      }),
    );
    await act(async () => {
      tree.update(
        <TranscriptEntry
          item={{
            ...item,
            images: [{ index: 0, mimeType: 'image/png', available: true }],
          }}
        />,
      );
      await Promise.resolve();
    });
    expect(sessionImage).toHaveBeenCalledTimes(1);
    const thumbnail = tree.root.findByProps({
      'aria-label': 'Open attached image 1',
    });

    await act(async () => {
      thumbnail.props.onClick();
      await Promise.resolve();
    });
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(sessionImage).toHaveBeenNthCalledWith(
      2,
      'session-1',
      'user-image-entry',
      0,
      expect.objectContaining({ messageTimestamp: 12345 }),
    );
    expect(tree.root.findByProps({ src: 'blob:full' })).toBeDefined();
    const close = tree.root.findByProps({
      'aria-label': 'Close image viewer',
    });
    expect(close.props.className).toBe('message-image-close');
    await act(async () => {
      close.props.onClick();
      tree.root
        .findByProps({ 'aria-label': 'Open attached image 1' })
        .props.onClick();
      await Promise.resolve();
    });
    expect(sessionImage).toHaveBeenCalledTimes(2);
    expect(tree.root.findByProps({ src: 'blob:full' })).toBeDefined();
    act(() => tree.unmount());
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:thumbnail');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:full');
  });

  it('navigates horizontal swipes and dismisses vertical swipes', async () => {
    sessionImage.mockClear();
    sessionImage.mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
    let url = 0;
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => `blob:image-${++url}`),
      revokeObjectURL: vi.fn(),
    });
    const dialogNode = {
      open: false,
      showModal: vi.fn(function (this: { open: boolean }) {
        this.open = true;
      }),
      close: vi.fn(function (this: { open: boolean }) {
        this.open = false;
      }),
    };
    const item: TranscriptModelItem = {
      key: 'gallery-entry',
      sessionId: 'session-1',
      raw: {},
      entry: { kind: 'other' },
      role: 'user',
      imageCount: 2,
      images: [
        { index: 0, mimeType: 'image/png', available: true },
        { index: 1, mimeType: 'image/png', available: true },
      ],
    };
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(<TranscriptEntry item={item} />, {
        createNodeMock: (element) =>
          element.type === 'dialog' ? dialogNode : {},
      });
      await Promise.resolve();
    });
    await act(async () => {
      tree.root
        .findByProps({ 'aria-label': 'Open attached image 1' })
        .props.onClick();
      await Promise.resolve();
    });
    let dialog = tree.root.findByType('dialog');
    expect(dialog.props['aria-label']).toBe('Attached image 1 of 2');

    await act(async () => {
      dialog.props.onPointerDown({
        pointerType: 'touch',
        target: { closest: () => null },
        pointerId: 1,
        clientX: 180,
        clientY: 100,
      });
      dialog.props.onPointerUp({
        pointerId: 1,
        clientX: 80,
        clientY: 105,
      });
      await Promise.resolve();
    });
    dialog = tree.root.findByType('dialog');
    expect(dialog.props['aria-label']).toBe('Attached image 2 of 2');
    await act(async () => {
      tree.root
        .findByProps({ 'aria-label': 'Previous attached image' })
        .props.onClick();
      await Promise.resolve();
    });
    expect(sessionImage).toHaveBeenCalledTimes(4);
    dialog = tree.root.findByType('dialog');
    expect(dialog.props['aria-label']).toBe('Attached image 1 of 2');
    await act(async () => {
      tree.root
        .findByProps({ 'aria-label': 'Next attached image' })
        .props.onClick();
      await Promise.resolve();
    });
    expect(sessionImage).toHaveBeenCalledTimes(4);
    dialog = tree.root.findByType('dialog');

    act(() => {
      dialog.props.onPointerDown({
        pointerType: 'touch',
        target: { closest: () => null },
        pointerId: 2,
        clientX: 100,
        clientY: 80,
      });
      dialog.props.onPointerUp({
        pointerId: 2,
        clientX: 105,
        clientY: 170,
      });
    });
    expect(dialogNode.close).toHaveBeenCalled();
    expect(tree.root.findByType('dialog').props['aria-label']).toBe(
      'Attached image viewer',
    );
    act(() => tree.unmount());
  });

  it('renders compact colored line metrics for edit tools', () => {
    const item: TranscriptModelItem = {
      key: 'tool:edit-call',
      raw: {},
      entry: {
        kind: 'tool',
        name: 'edit',
        args: {},
        status: 'success',
      },
      tool: {
        kind: 'tool',
        key: 'tool:edit-call',
        toolCallId: 'edit-call',
        name: 'edit',
        arguments: {
          path: 'src/App.tsx',
          edits: [
            {
              oldText: 'old one\nold two',
              newText: 'new one\nnew two\nnew three',
            },
            { oldText: 'remove me', newText: '' },
          ],
        },
        status: 'success',
      },
    };

    const markup = renderToStaticMarkup(<TranscriptEntry item={item} />);

    expect(markup).toContain('class="tool-argument-text"');
    expect(markup).toContain('class="line-change-added">+1</span>');
    expect(markup).toContain('class="line-change-changed">~2</span>');
    expect(markup).toContain('class="line-change-removed">-1</span>');
    expect(markup).not.toContain(' added</span>');
    expect(markup).not.toContain(' changed</span>');
    expect(markup).not.toContain(' removed</span>');
  });

  it('shows an error marker for failed tool calls', () => {
    const item: TranscriptModelItem = {
      key: 'tool:error-call',
      raw: {},
      entry: {
        kind: 'tool',
        name: 'bash',
        args: { command: 'false' },
        status: 'error',
        isError: true,
      },
      tool: {
        kind: 'tool',
        key: 'tool:error-call',
        toolCallId: 'error-call',
        name: 'bash',
        arguments: { command: 'false' },
        result: 'Command failed',
        status: 'error',
        isError: true,
      },
    };

    const markup = renderToStaticMarkup(<TranscriptEntry item={item} />);

    expect(markup).toContain('tool-detail role-command step-failed');
    expect(markup).toContain(
      '<span class="tool-step-dot" aria-hidden="true">!</span>',
    );
  });
});
