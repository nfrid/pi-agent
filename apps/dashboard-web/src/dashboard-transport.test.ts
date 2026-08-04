import { describe, expect, it } from 'vitest';
import {
  asBrowserSnapshot,
  asSessionResponse,
  enqueueStreamEvent,
  nextReconnectDelay,
  reconnectDelayWithJitter,
  shouldAcceptRevision,
} from './dashboard-transport';

describe('dashboard transport revisions', () => {
  it('rejects snapshots older than the browser cursor', () => {
    expect(shouldAcceptRevision(7, 6)).toBe(false);
    expect(shouldAcceptRevision(7, 7)).toBe(false);
    expect(shouldAcceptRevision(7, 8)).toBe(true);
  });

  it('preserves the server generation used to reset revisions after restart', () => {
    expect(
      asBrowserSnapshot({
        serverId: 'daemon-2',
        revision: 0,
        runtimes: [],
        workspaces: [],
        sessions: [],
      })?.serverId,
    ).toBe('daemon-2');
  });

  it('rejects malformed nested state before it can reach React', () => {
    expect(
      asBrowserSnapshot({
        serverId: 'daemon',
        revision: 1,
        runtimes: [{}],
        workspaces: [],
        sessions: [],
        unread: [],
      }),
    ).toBeUndefined();
    expect(
      asBrowserSnapshot({
        serverId: 'daemon',
        revision: Number.NaN,
        runtimes: [],
        workspaces: [],
        sessions: [],
        unread: [],
      }),
    ).toBeUndefined();
    expect(
      asSessionResponse({
        metadata: { id: 'session', cwd: '/tmp', name: {} },
        entries: [],
      }),
    ).toBeUndefined();
  });

  it('coalesces streaming deltas but preserves starts, finishes, and distinct tools', () => {
    const event = (type: string, id: string, text: string) => ({
      type: 'event',
      revision: text.length,
      runtimeId: 'runtime',
      event: {
        type,
        sessionId: 'session',
        tool: { toolCallId: id, text },
      },
    });
    let pending = enqueueStreamEvent([], event('tool.started', 'a', 'start'));
    pending = enqueueStreamEvent(pending, event('tool.updated', 'a', 'one'));
    pending = enqueueStreamEvent(pending, event('tool.updated', 'a', 'latest'));
    pending = enqueueStreamEvent(pending, event('tool.updated', 'b', 'other'));
    expect(pending).toHaveLength(3);
    expect(JSON.stringify(pending)).not.toContain('one');
    expect(JSON.stringify(pending)).toContain('latest');
    pending = enqueueStreamEvent(
      pending,
      event('tool.finished', 'a', 'finished'),
    );
    expect(pending).toHaveLength(3);
    expect(JSON.stringify(pending)).not.toContain('latest');
    expect(JSON.stringify(pending)).toContain('finished');

    const messageEvent = (type: string, text: string, responseId?: string) => ({
      type: 'event',
      revision: text.length,
      runtimeId: 'runtime',
      event: {
        type,
        sessionId: 'session',
        message: {
          role: 'assistant',
          timestamp: 123,
          ...(responseId ? { responseId } : {}),
          content: [{ type: 'text', text }],
        },
      },
    });
    let messages = enqueueStreamEvent(
      [],
      messageEvent('message.updated', 'first'),
    );
    messages = enqueueStreamEvent(
      messages,
      messageEvent('message.updated', 'latest', 'response-later'),
    );
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain('first');
    messages = enqueueStreamEvent(
      messages,
      messageEvent('message.finished', 'final', 'response-later'),
    );
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain('latest');
  });

  it('caps exponential reconnect delay and applies bounded jitter', () => {
    expect(nextReconnectDelay(500)).toBe(1_000);
    expect(nextReconnectDelay(20_000)).toBe(30_000);
    expect(reconnectDelayWithJitter(1_000, () => 0)).toBe(800);
    expect(reconnectDelayWithJitter(1_000, () => 1)).toBe(1_200);
  });
});
