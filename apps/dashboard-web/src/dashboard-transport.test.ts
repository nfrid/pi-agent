import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import type { DashboardEvent } from './dashboard-transport';
import {
  asBrowserSnapshot,
  asSessionResponse,
  consumeSseResponse,
  enqueueStreamEvent,
  nextReconnectDelay,
  reconnectDelayWithJitter,
  shouldAcceptRevision,
  shouldReconnectAfterConnectUnwind,
  snapshotAcceptance,
} from './dashboard-transport';

describe('dashboard transport revisions', () => {
  it('rejects snapshots older than the browser cursor', () => {
    expect(shouldAcceptRevision(7, 6)).toBe(false);
    expect(shouldAcceptRevision(7, 7)).toBe(false);
    expect(shouldAcceptRevision(7, 8)).toBe(true);
  });

  it('resets the cursor window when a replacement daemon has a lower cursor', () => {
    const lower = { serverId: 'daemon-2', cursor: 1 } as BrowserSnapshot;
    expect(snapshotAcceptance('daemon-1', 9, lower)).toEqual({
      accepted: true,
      reset: true,
    });
    expect(
      snapshotAcceptance('daemon-1', 9, {
        ...lower,
        serverId: 'daemon-1',
      }),
    ).toEqual({ accepted: false, reset: false });
  });

  it('rejects an old HTTP response after a newer SSE generation is authoritative', () => {
    const oldResponse = {
      serverId: 'daemon-1',
      cursor: 12,
    } as BrowserSnapshot;
    expect(
      snapshotAcceptance('daemon-2', 2, oldResponse, {
        source: 'http',
        requestGeneration: 0,
        currentGeneration: 1,
      }),
    ).toEqual({ accepted: false, reset: false });
    expect(
      snapshotAcceptance(
        'daemon-2',
        2,
        {
          ...oldResponse,
          serverId: 'daemon-3',
        },
        {
          source: 'http',
          requestGeneration: 1,
          currentGeneration: 1,
        },
      ),
    ).toEqual({ accepted: true, reset: true });
  });

  it('dispatches every CRLF data frame from one long-lived response', async () => {
    const encoder = new TextEncoder();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    const records: number[] = [];
    bodyController?.enqueue(
      encoder.encode(
        ': heartbeat\r\n\r\nid: 1\r\nevent: dashboard\r\ndata: ' +
          JSON.stringify({
            cursor: 1,
            emittedAt: 1,
            event: { type: 'agent.settled', sessionId: 'session' },
          }) +
          '\r\n\r\n',
      ),
    );
    let requests = 0;
    const response = (() => {
      requests += 1;
      return new Response(body);
    })();
    const abort = new AbortController();
    const consuming = consumeSseResponse(
      response,
      (record) => {
        records.push(record.cursor);
        return undefined;
      },
      abort.signal,
    );
    bodyController?.enqueue(
      encoder.encode(
        `id: 2\r\nevent: dashboard\r\ndata: ${JSON.stringify({
          cursor: 2,
          emittedAt: 2,
          event: { type: 'agent.settled', sessionId: 'session' },
        })}\r\n\r\n`,
      ),
    );
    await expect.poll(() => records).toEqual([1, 2]);
    expect(requests).toBe(1);
    abort.abort();
    await expect(consuming).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects an unterminated SSE frame over the bounded limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
    });
    await expect(
      consumeSseResponse(new Response(body), () => undefined),
    ).rejects.toThrow('frame exceeds');
  });

  it('preserves the server generation used to reset revisions after restart', () => {
    expect(
      asBrowserSnapshot({
        serverId: 'daemon-2',
        revision: 0,
        runtimes: [],
        workspaces: [],
        sessions: [],
        unread: [],
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
    expect(
      asSessionResponse({
        metadata: {
          id: 'session',
          file: '',
          cwd: '/tmp',
          updatedAt: 1,
          unexpected: true,
        },
        entries: [],
      }),
    ).toBeUndefined();
  });

  it('keeps the explicit legacy HTTP snapshot defaults at the parser boundary', () => {
    expect(
      asBrowserSnapshot({
        runtimes: [],
        workspaces: [],
        sessions: [],
      }),
    ).toMatchObject({ serverId: 'legacy', revision: 0, unread: [] });
    expect(
      asSessionResponse({
        metadata: {
          id: 'session',
          file: '',
          cwd: '/tmp',
          updatedAt: 1,
        },
        entries: [],
      }),
    ).toMatchObject({ metadata: { id: 'session' }, entries: [] });
  });

  it('coalesces normalized streaming deltas but preserves starts, finishes, and distinct tools', () => {
    const event = (
      type: 'tool.started' | 'tool.updated' | 'tool.finished',
      id: string,
      text: string,
    ): DashboardEvent => ({
      type: 'event',
      serverId: 'daemon',
      revision: text.length,
      runtimeId: 'runtime',
      event: {
        type,
        sessionId: 'session',
        tool: { toolCallId: id, name: 'read', result: text },
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

    const messageEvent = (
      type: 'message.updated' | 'message.finished',
      text: string,
      messageId: string,
    ): DashboardEvent => ({
      type: 'event',
      serverId: 'daemon',
      revision: text.length,
      runtimeId: 'runtime',
      event: {
        type,
        sessionId: 'session',
        message: {
          messageId,
          role: 'assistant',
          content: [{ type: 'text', text }],
        },
      },
    });
    let messages = enqueueStreamEvent(
      [],
      messageEvent('message.updated', 'first', 'message-1'),
    );
    messages = enqueueStreamEvent(
      messages,
      messageEvent('message.updated', 'latest', 'message-1'),
    );
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain('first');
    messages = enqueueStreamEvent(
      messages,
      messageEvent('message.finished', 'final', 'message-1'),
    );
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain('latest');
  });

  it('does not coalesce a transcript event without its explicit normalized identity', () => {
    const event = (text: string): DashboardEvent => ({
      type: 'event',
      serverId: 'daemon',
      revision: text.length,
      runtimeId: 'runtime',
      event: {
        type: 'message.updated',
        sessionId: 'session',
        message: { role: 'assistant', content: text },
      },
    });
    const pending = enqueueStreamEvent(
      enqueueStreamEvent([], event('first')),
      event('second'),
    );
    expect(pending).toHaveLength(2);
  });

  it('reconnects when online arrives while an offline abort is unwinding', () => {
    expect(shouldReconnectAfterConnectUnwind(true, false, true)).toBe(true);
    expect(shouldReconnectAfterConnectUnwind(true, false, false)).toBe(false);
    expect(shouldReconnectAfterConnectUnwind(false, false, true)).toBe(false);
  });

  it('caps exponential reconnect delay and applies bounded jitter', () => {
    expect(nextReconnectDelay(500)).toBe(1_000);
    expect(nextReconnectDelay(20_000)).toBe(30_000);
    expect(reconnectDelayWithJitter(1_000, () => 0)).toBe(800);
    expect(reconnectDelayWithJitter(1_000, () => 1)).toBe(1_200);
  });
});
