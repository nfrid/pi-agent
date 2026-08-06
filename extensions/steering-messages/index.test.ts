import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
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
  return { appendEntry, emit, handlers };
}

describe('steering message tracking', () => {
  it('records and publishes an explicitly steered user message', () => {
    const { appendEntry, emit, handlers } = harness();
    handlers.get('input')?.({
      text: 'redirect',
      streamingBehavior: 'steer',
    } as never);
    handlers.get('message_start')?.(
      {
        message: { role: 'user', content: 'redirect', timestamp: 42 },
      } as never,
      { sessionManager: { getSessionId: () => 'session-1' } } as never,
    );
    expect(appendEntry).toHaveBeenCalledWith(STEERING_MESSAGE_MARKER_TYPE, {
      timestamp: 42,
      text: 'redirect',
    });
    expect(emit).toHaveBeenCalledWith('steering-message:marked', {
      sessionId: 'session-1',
      message: { role: 'user', content: 'redirect', timestamp: 42 },
    });
  });

  it('matches a transformed steering input to the next delivered user message', () => {
    const { appendEntry, handlers } = harness();
    handlers.get('input')?.({
      text: '/template',
      streamingBehavior: 'steer',
    } as never);
    handlers.get('message_start')?.(
      {
        message: { role: 'user', content: 'Expanded template', timestamp: 43 },
      } as never,
      { sessionManager: { getSessionId: () => 'session-1' } } as never,
    );
    expect(appendEntry).toHaveBeenCalledWith(STEERING_MESSAGE_MARKER_TYPE, {
      timestamp: 43,
      text: 'Expanded template',
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
