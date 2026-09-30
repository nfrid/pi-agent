import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { markLogicalSteering } from '../shared/runtime/logical-input';
import {
  createTuiShimHost,
  loadHistoryMarks,
  registerSteeringMessageTracking,
  STEERING_MESSAGE_MARKER_TYPE,
} from './index';

type Handler = (event: never, context?: never) => unknown;

function harness() {
  const handlers = new Map<string, Handler>();
  const appendEntry = vi.fn();
  const emit = vi.fn();
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry,
    events: { emit },
  } as unknown as ExtensionAPI;
  registerSteeringMessageTracking(pi);
  const sessionStart = handlers.get('session_start');
  sessionStart?.(
    {} as never,
    {
      mode: 'rpc',
      sessionManager: { buildContextEntries: () => [] },
    } as never,
  );
  return {
    appendEntry,
    emit,
    handlers,
    persist(message: object, id = 'user-entry', event = 'message_end') {
      handlers.get(event)?.(
        { message } as never,
        {
          sessionManager: {
            getBranch: () => [{ type: 'message', id, message }],
          },
        } as never,
      );
    },
  };
}

describe('steering message tracking', () => {
  it('renders a retained rail after its session context becomes stale', () => {
    let stale = false;
    const theme = {
      fg: (color: string, text: string) => `fg:${color}:${text}`,
      bg: (color: string, text: string) => `bg:${color}:${text}`,
    };
    const context = {
      get ui() {
        if (stale) throw new Error('stale session context');
        return { theme };
      },
    } as never;
    const host = createTuiShimHost(() => true, context);

    stale = true;

    expect(host.renderBorderCell('▏', true)).toBe(
      'bg:userMessageBg:fg:warning:▏',
    );
  });

  it('records and publishes an explicitly steered user message', () => {
    const { appendEntry, emit, handlers, persist } = harness();
    handlers.get('input')?.({
      text: 'redirect',
      streamingBehavior: 'steer',
    } as never);
    const message = { role: 'user', content: 'redirect', timestamp: 42 };
    markLogicalSteering(message);
    handlers.get('message_start')?.(
      { message } as never,
      { sessionManager: { getSessionId: () => 'session-1' } } as never,
    );
    expect(appendEntry).not.toHaveBeenCalled();
    persist(message);
    expect(appendEntry).toHaveBeenCalledWith(STEERING_MESSAGE_MARKER_TYPE, {
      userEntryId: 'user-entry',
      timestamp: 42,
      text: 'redirect',
    });
    expect(emit).toHaveBeenCalledWith('steering-message:marked', {
      sessionId: 'session-1',
      message: { role: 'user', content: 'redirect', timestamp: 42 },
    });
  });

  it('matches a transformed steering input to the next delivered user message', () => {
    const { appendEntry, handlers, persist } = harness();
    handlers.get('input')?.({
      text: '/template',
      streamingBehavior: 'steer',
    } as never);
    const message = {
      role: 'user',
      content: 'Expanded template',
      timestamp: 43,
    };
    markLogicalSteering(message);
    handlers.get('message_start')?.(
      { message } as never,
      { sessionManager: { getSessionId: () => 'session-1' } } as never,
    );
    persist(message);
    expect(appendEntry).toHaveBeenCalledWith(STEERING_MESSAGE_MARKER_TYPE, {
      userEntryId: 'user-entry',
      timestamp: 43,
      text: 'Expanded template',
    });
  });

  it('binds only the same native object and persists at most one marker', () => {
    const { appendEntry, handlers, persist } = harness();
    const message = { role: 'user', content: 'identical', timestamp: 43 };
    markLogicalSteering(message);
    handlers.get('input')?.({
      text: 'identical',
      streamingBehavior: 'steer',
    } as never);
    handlers.get('message_start')?.(
      { message } as never,
      { sessionManager: { getSessionId: () => 'session-1' } } as never,
    );
    persist({ ...message }, 'wrong-entry');
    expect(appendEntry).not.toHaveBeenCalled();
    persist(message, 'exact-entry', 'context');
    persist(message, 'exact-entry');
    expect(appendEntry).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledWith(STEERING_MESSAGE_MARKER_TYPE, {
      text: 'identical',
      timestamp: 43,
      userEntryId: 'exact-entry',
    });
  });

  it('does not give a legacy text collision exact ownership', () => {
    const { appendEntry, emit, handlers, persist } = harness();
    handlers.get('input')?.({
      text: 'collision',
      streamingBehavior: 'steer',
    } as never);
    const ordinary = { role: 'user', content: 'collision', timestamp: 42 };
    handlers.get('message_start')?.(
      { message: ordinary } as never,
      { sessionManager: { getSessionId: () => 'session-1' } } as never,
    );
    persist(ordinary);
    expect(appendEntry).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('steering-message:marked', {
      sessionId: 'session-1',
      message: ordinary,
    });

    const native = { role: 'user', content: 'collision', timestamp: 43 };
    markLogicalSteering(native);
    handlers.get('message_start')?.(
      { message: native } as never,
      { sessionManager: { getSessionId: () => 'session-1' } } as never,
    );
    persist(native, 'native-entry');
    expect(appendEntry).toHaveBeenCalledWith(STEERING_MESSAGE_MARKER_TYPE, {
      userEntryId: 'native-entry',
      timestamp: 43,
      text: 'collision',
    });
  });

  it('clears an undelivered steering input when the agent settles', () => {
    const { appendEntry, handlers } = harness();
    handlers.get('input')?.({
      text: 'handled by another extension',
      streamingBehavior: 'steer',
    } as never);
    handlers.get('agent_settled')?.({} as never);
    handlers.get('message_start')?.({
      message: { role: 'user', content: 'ordinary', timestamp: 44 },
    } as never);
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it('requires marker text when matching colliding history timestamps', () => {
    const marks = loadHistoryMarks([
      {
        type: 'message',
        message: { role: 'user', content: 'first', timestamp: 50 },
      },
      {
        type: 'message',
        message: { role: 'user', content: 'second', timestamp: 50 },
      },
      {
        type: 'custom',
        customType: STEERING_MESSAGE_MARKER_TYPE,
        data: { timestamp: 50, text: 'second' },
      },
    ]);
    expect(marks.marked.get('first')).toBeUndefined();
    expect(marks.marked.get('second')).toEqual(new Set([0]));
  });

  it('reloads marker marks when session tree navigation replaces the branch', () => {
    const handlers = new Map<string, Handler>();
    const pi = {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
    } as unknown as ExtensionAPI;
    const resolvers: Array<(text: string, occurrence: number) => boolean> = [];
    registerSteeringMessageTracking(pi, (isSteering) => {
      resolvers.push(isSteering);
      return undefined;
    });
    const context = (entries: unknown[]) =>
      ({
        mode: 'tui',
        sessionManager: { buildContextEntries: () => entries },
      }) as never;
    const start = handlers.get('session_start');
    const tree = handlers.get('session_tree');
    start?.(
      {} as never,
      context([
        {
          type: 'message',
          message: { role: 'user', content: 'first', timestamp: 1 },
        },
        {
          type: 'custom',
          customType: STEERING_MESSAGE_MARKER_TYPE,
          data: { timestamp: 1, text: 'first' },
        },
      ]),
    );
    expect(resolvers[0]?.('first', 0)).toBe(true);
    tree?.(
      {} as never,
      context([
        {
          type: 'message',
          message: { role: 'user', content: 'second', timestamp: 2 },
        },
        {
          type: 'custom',
          customType: STEERING_MESSAGE_MARKER_TYPE,
          data: { timestamp: 2, text: 'second' },
        },
      ]),
    );
    expect(resolvers).toHaveLength(2);
    expect(resolvers[1]?.('second', 0)).toBe(true);
  });

  it('keeps follow-up and ordinary input unmarked', () => {
    const { appendEntry, handlers } = harness();
    const start = handlers.get('message_start');
    handlers.get('input')?.({
      text: 'follow later',
      streamingBehavior: 'followUp',
    } as never);
    start?.({
      message: { role: 'user', content: 'follow later', timestamp: 43 },
    } as never);
    handlers.get('input')?.({ text: 'ordinary' } as never);
    start?.({
      message: { role: 'user', content: 'ordinary', timestamp: 44 },
    } as never);
    expect(appendEntry).not.toHaveBeenCalled();
  });
});
