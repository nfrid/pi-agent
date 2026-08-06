import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  registerSteeringMessageTracking,
  STEERING_MESSAGE_MARKER_TYPE,
} from './index';

type Handler = (event: never, context?: never) => unknown;

function harness() {
  const handlers = new Map<string, Handler>();
  const appendEntry = vi.fn();
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry,
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
  return { appendEntry, handlers };
}

describe('steering message tracking', () => {
  it('records a durable marker only for an explicitly steered user message', () => {
    const { appendEntry, handlers } = harness();
    handlers.get('input')?.({
      text: 'redirect',
      streamingBehavior: 'steer',
    } as never);
    handlers.get('message_start')?.({
      message: { role: 'user', content: 'redirect', timestamp: 42 },
    } as never);
    expect(appendEntry).toHaveBeenCalledWith(STEERING_MESSAGE_MARKER_TYPE, {
      timestamp: 42,
    });
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
