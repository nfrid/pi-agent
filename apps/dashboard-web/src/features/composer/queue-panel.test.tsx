import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedMessage } from './queue';

const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useMutation: () => ({
    isPending: mocks.isPending,
    mutateAsync: mocks.mutateAsync,
  }),
}));
vi.mock('react-aria-components', () => ({
  Button: ({
    children,
    isDisabled,
    onPress,
    ...props
  }: {
    children?: React.ReactNode;
    isDisabled?: boolean;
    onPress?: () => void;
    [key: string]: unknown;
  }) =>
    React.createElement(
      'button',
      { ...props, type: 'button', disabled: isDisabled, onClick: onPress },
      children,
    ),
}));

import React from 'react';
import { QueuePanel, queuedMessagesForRuntime } from './queue';

function nativeRuntime(
  overrides: Partial<RuntimeSnapshot> = {},
): RuntimeSnapshot {
  return {
    runtimeId: 'runtime-1',
    online: true,
    liveState: 'working',
    session: { id: 'session-1', entries: [] },
    capabilities: {
      capabilities: [{ id: 'remote-control.native-steering', available: true }],
      manifests: [{ actions: [{ id: 'queue.steer-now' }] }],
    },
    ...overrides,
  } as unknown as RuntimeSnapshot;
}

const row = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id: 'head',
  mode: 'steer',
  text: 'steer this',
  revision: 2,
  ...overrides,
});

function renderPanel({
  runtime = nativeRuntime(),
  runtimeId = 'runtime-1',
  items = [row()],
  onItemsChange = vi.fn(),
}: {
  runtime?: RuntimeSnapshot;
  runtimeId?: string;
  items?: readonly QueuedMessage[];
  onItemsChange?: React.ComponentProps<typeof QueuePanel>['onItemsChange'];
} = {}) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <QueuePanel
        runtime={runtime}
        runtimeId={runtimeId}
        items={items}
        onItemsChange={onItemsChange}
      />,
    );
  });
  return renderer;
}

function sendButton(
  renderer: ReturnType<typeof create>,
): ReactTestInstance | undefined {
  return renderer.root
    .findAllByType('button')
    .find((button) => button.props['aria-label'] === 'Send steer now');
}

beforeEach(() => {
  mocks.mutateAsync.mockReset();
  mocks.isPending = false;
});

describe('QueuePanel', () => {
  it('guards runtime availability and ID mismatch', () => {
    const cases: [string, RuntimeSnapshot, string, boolean][] = [
      [
        'missing capability',
        nativeRuntime({ capabilities: undefined } as Partial<RuntimeSnapshot>),
        'runtime-1',
        false,
      ],
      [
        'unavailable capability',
        nativeRuntime({
          capabilities: {
            capabilities: [
              { id: 'remote-control.native-steering', available: false },
            ],
            manifests: [{ actions: [{ id: 'queue.steer-now' }] }],
          },
        } as unknown as Partial<RuntimeSnapshot>),
        'runtime-1',
        false,
      ],
      [
        'offline',
        nativeRuntime({ online: false } as unknown as Partial<RuntimeSnapshot>),
        'runtime-1',
        false,
      ],
      [
        'idle descriptor',
        nativeRuntime({
          liveState: 'idle',
          capabilities: {
            capabilities: [
              { id: 'remote-control.native-steering', available: true },
            ],
            manifests: [
              {
                actions: [
                  {
                    id: 'queue.steer-now',
                    availability: { liveStates: ['working'] },
                  },
                ],
              },
            ],
          },
        } as unknown as Partial<RuntimeSnapshot>),
        'runtime-1',
        false,
      ],
      ['runtime mismatch', nativeRuntime(), 'runtime-2', false],
    ];
    for (const [label, runtime, runtimeId, visible] of cases) {
      const renderer = renderPanel({ runtime, runtimeId });
      expect(Boolean(sendButton(renderer)), label).toBe(visible);
      renderer.unmount();
    }
  });

  it('uses the first steer row and blocks later steer rows behind ineligible rows', () => {
    const supported = (items: readonly QueuedMessage[]) => {
      const renderer = renderPanel({ items });
      const visible = Boolean(sendButton(renderer));
      renderer.unmount();
      return visible;
    };
    expect(
      supported([{ id: 'follow', mode: 'followUp', text: 'later' }, row()]),
    ).toBe(true);
    expect(
      supported([row({ id: 'attached', imageCount: 1 }), row({ id: 'later' })]),
    ).toBe(false);
    expect(
      supported([
        row({ id: 'missing-revision', revision: undefined }),
        row({ id: 'later' }),
      ]),
    ).toBe(false);
    expect(
      supported([
        row({ id: 'invalid-revision', revision: 1.5 }),
        row({ id: 'later' }),
      ]),
    ).toBe(false);
    expect(supported([row({ mode: 'followUp' })])).toBe(false);
    expect(supported([row({ imageCount: 1 })])).toBe(false);
    expect(supported([row({ revision: undefined })])).toBe(false);
  });

  it('blocks unresolved handoffs, editing, and pending controls', () => {
    for (const status of ['handing-off', 'accepted', 'uncertain'] as const) {
      const renderer = renderPanel({
        items: [row({ status }), row({ id: 'next' })],
      });
      expect(sendButton(renderer)).toBeUndefined();
      renderer.unmount();
    }
    const editing = renderPanel();
    act(() =>
      editing.root
        .findByProps({ 'aria-label': 'Edit queued steer message' })
        .props.onPress(),
    );
    expect(sendButton(editing)).toBeUndefined();
    editing.unmount();

    mocks.isPending = true;
    const pending = renderPanel();
    expect(sendButton(pending)?.props.disabled).toBe(true);
    expect(
      pending.root.findByProps({ 'aria-label': 'Edit queued steer message' })
        .props.isDisabled,
    ).toBe(true);
    pending.unmount();
  });

  it('sends the exact action payload once and leaves the row untouched on acceptance', async () => {
    let resolve!: () => void;
    mocks.mutateAsync.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    const onItemsChange = vi.fn();
    const renderer = renderPanel({ onItemsChange });
    const button = sendButton(renderer);
    if (!button) throw new Error('Send-now button should be available');
    act(() => {
      button.props.onClick();
      button.props.onClick();
    });
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    const [{ runtimeId, command }] = mocks.mutateAsync.mock.calls[0] as [
      { runtimeId: string; command: Record<string, unknown> },
    ];
    expect(runtimeId).toBe('runtime-1');
    expect(command).toMatchObject({
      type: 'action.invoke',
      actionId: 'queue.steer-now',
      input: { clientId: 'head', revision: 2, expectedSessionId: 'session-1' },
    });
    await act(async () => resolve());
    expect(onItemsChange).not.toHaveBeenCalled();
    expect(
      renderer.root.findAllByProps({
        'aria-label': 'Queued steer message: steer this',
      }),
    ).toHaveLength(1);
    renderer.unmount();
  });

  it('surfaces failures only for the issuing runtime and ignores late replacement-session failures', async () => {
    let reject!: (error: Error) => void;
    mocks.mutateAsync.mockReturnValueOnce(
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
    );
    const renderer = renderPanel();
    act(() => sendButton(renderer)?.props.onClick());
    act(() =>
      renderer.update(
        <QueuePanel
          runtime={nativeRuntime({
            runtimeId: 'runtime-2',
            session: { id: 'session-2', entries: [] },
          } as unknown as Partial<RuntimeSnapshot>)}
          runtimeId="runtime-2"
          items={[row()]}
          onItemsChange={vi.fn()}
        />,
      ),
    );
    await act(async () => reject(new Error('send failed')));
    expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    renderer.unmount();

    mocks.mutateAsync.mockRejectedValueOnce(new Error('send failed'));
    const failed = renderPanel();
    await act(async () => sendButton(failed)?.props.onClick());
    expect(failed.root.findAllByProps({ role: 'alert' })).toHaveLength(1);
    failed.unmount();
  });
  it('renders an admitted row supplied only by the backend handoff snapshot', () => {
    const runtime = {
      queueDrafts: [],
      queueHandoffs: [
        {
          clientId: 'admitted',
          mode: 'steer',
          text: 'send this while busy',
          revision: 1,
          status: 'accepted',
        },
      ],
    } as unknown as RuntimeSnapshot;
    const markup = renderToStaticMarkup(
      <QueuePanel
        runtimeId="runtime-1"
        items={queuedMessagesForRuntime(runtime)}
        onItemsChange={() => undefined}
      />,
    );
    expect(markup).toContain('send this while busy');
    expect(markup).toContain('Accepted by Pi, not confirmed applied');
    expect(markup).toMatch(
      /<button(?=[^>]*disabled)(?=[^>]*aria-label="Edit queued steer message")[^>]*>/,
    );
  });

  it('shows native send-now only for an available dynamic action on the head revision', () => {
    const runtime = {
      runtimeId: 'runtime-1',
      online: true,
      liveState: 'working',
      session: { id: 'session-1', entries: [] },
      capabilities: {
        capabilities: [
          { id: 'remote-control.native-steering', available: true },
        ],
        manifests: [{ actions: [{ id: 'queue.steer-now' }] }],
      },
    } as unknown as RuntimeSnapshot;
    const item = {
      id: 'head',
      mode: 'steer' as const,
      text: 'steer',
      revision: 2,
    };
    const markup = renderToStaticMarkup(
      <QueuePanel
        runtimeId="runtime-1"
        runtime={runtime}
        items={[
          item,
          { id: 'later', mode: 'steer', text: 'later', revision: 1 },
        ]}
        onItemsChange={() => undefined}
      />,
    );
    expect(markup).toContain('aria-label="Send steer now"');

    const unavailable = renderToStaticMarkup(
      <QueuePanel
        runtimeId="runtime-1"
        runtime={
          {
            ...runtime,
            capabilities: { ...runtime.capabilities, capabilities: [] },
          } as unknown as RuntimeSnapshot
        }
        items={[item]}
        onItemsChange={() => undefined}
      />,
    );
    expect(unavailable).not.toContain('aria-label="Send steer now"');
  });

  it('exposes icon actions and backend handoff status without queue chrome', () => {
    const items: readonly QueuedMessage[] = [
      { id: 'waiting', mode: 'steer', text: 'inspect this' },
      {
        id: 'accepted',
        mode: 'followUp',
        text: 'send this later',
        status: 'accepted',
      },
    ];
    const markup = renderToStaticMarkup(
      <QueuePanel
        runtimeId="runtime-1"
        items={items}
        onItemsChange={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Steer current work"');
    expect(markup).toContain('aria-label="Send later"');
    expect(markup).toContain('aria-label="Edit queued steer message"');
    expect(markup).toContain('aria-label="Remove queued steer message"');
    expect(markup).toContain('Accepted by Pi, not confirmed applied');
    expect(markup).not.toContain('>Edit<');
    expect(markup).toMatch(
      /<button(?=[^>]*disabled)(?=[^>]*aria-label="Edit queued follow-up message")[^>]*>/,
    );
    expect(markup).toMatch(
      /<button(?=[^>]*disabled)(?=[^>]*aria-label="Remove queued follow-up message")[^>]*>/,
    );
  });
});
