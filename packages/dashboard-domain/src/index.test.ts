import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  applyRuntimeEvent,
  applyTranscriptEvent,
  createRuntimeReducerState,
  createTranscriptProjection,
  hydrateTranscript,
  selectLegacyTranscriptEntries,
} from './index.js';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8'),
  );

const snapshot = (): RuntimeSnapshot => ({
  runtimeId: 'r',
  ownership: 'managed',
  pid: 1,
  cwd: '/tmp',
  liveState: 'idle',
  session: { id: 's', entries: [] },
  pendingInteractions: [],
});

function envelope(
  cursor: number,
  runtimeSeq: number,
  event: Record<string, unknown>,
  runtimeEpoch = 'epoch-1',
  sessionId = 's',
) {
  return {
    cursor,
    emittedAt: cursor,
    runtimeId: 'r',
    runtimeEpoch,
    runtimeSeq,
    sessionId,
    event,
  } as never;
}

describe('dashboard domain reducers', () => {
  it('replays persisted and live fixture data deterministically', () => {
    const runtimeSnapshot = fixture('snapshot.json') as RuntimeSnapshot;
    const events = readFileSync(
      join(import.meta.dirname, '..', 'fixtures', 'events.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const expected = fixture('expected-projection.json');
    const hydrated = hydrateTranscript(
      runtimeSnapshot.session.entries,
      runtimeSnapshot.session.id,
    );
    const once = events.reduce(
      (state, event) => applyTranscriptEvent(state, event).state,
      hydrated,
    );
    const twice = events.reduce(
      (state, event) => applyTranscriptEvent(state, event).state,
      hydrateTranscript(
        runtimeSnapshot.session.entries,
        runtimeSnapshot.session.id,
      ),
    );
    expect(once).toEqual(expected);
    expect(twice).toEqual(once);
  });

  it('rejects duplicate cursor/sequence events and preserves finished entities', () => {
    let state = hydrateTranscript([], 's');
    const finished = envelope(1, 1, {
      type: 'message.finished',
      sessionId: 's',
      message: {
        messageId: 'message-1',
        role: 'assistant',
        content: 'final',
        phase: 'finished',
      },
    });
    state = applyTranscriptEvent(state, finished).state;
    const duplicate = applyTranscriptEvent(state, finished);
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.reason).toBe('old-cursor');
    const olderUpdate = applyTranscriptEvent(
      state,
      envelope(2, 2, {
        type: 'message.updated',
        sessionId: 's',
        message: {
          messageId: 'message-1',
          role: 'assistant',
          content: 'stale partial',
          phase: 'updated',
        },
      }),
    );
    expect(olderUpdate.state.items['message-1']).toMatchObject({
      content: 'final',
      status: 'finished',
    });
  });

  it('keeps terminal message and tool items inert for later lifecycle events', () => {
    let state = hydrateTranscript([], 's');
    state = applyTranscriptEvent(
      state,
      envelope(1, 1, {
        type: 'tool.started',
        sessionId: 's',
        tool: {
          toolCallId: 'call-1',
          name: 'read',
          arguments: { path: '/tmp/file' },
          data: { providerTrace: 'trace-1' },
          phase: 'started',
        },
      }),
    ).state;
    state = applyTranscriptEvent(
      state,
      envelope(2, 2, {
        type: 'tool.updated',
        sessionId: 's',
        tool: {
          toolCallId: 'call-1',
          name: 'read',
          status: 'running',
          phase: 'updated',
        },
      }),
    ).state;
    state = applyTranscriptEvent(
      state,
      envelope(3, 3, {
        type: 'tool.finished',
        sessionId: 's',
        tool: {
          toolCallId: 'call-1',
          name: 'read',
          result: 'first result',
          status: 'completed',
          phase: 'finished',
        },
      }),
    ).state;
    const terminal = state.items['call-1'];
    expect(terminal).toMatchObject({
      arguments: { path: '/tmp/file' },
      result: 'first result',
      data: { providerTrace: 'trace-1' },
      status: 'finished',
    });
    const staleTool = applyTranscriptEvent(
      state,
      envelope(4, 4, {
        type: 'tool.finished',
        sessionId: 's',
        tool: {
          toolCallId: 'call-1',
          name: 'read',
          result: 'stale result',
          phase: 'finished',
        },
      }),
    );
    expect(staleTool.state.items['call-1']).toEqual(terminal);

    state = applyTranscriptEvent(
      state,
      envelope(5, 5, {
        type: 'message.finished',
        sessionId: 's',
        message: {
          messageId: 'message-1',
          role: 'assistant',
          content: 'final',
          phase: 'finished',
        },
      }),
    ).state;
    const message = state.items['message-1'];
    const staleMessage = applyTranscriptEvent(
      state,
      envelope(6, 6, {
        type: 'message.finished',
        sessionId: 's',
        message: {
          messageId: 'message-1',
          role: 'assistant',
          content: 'replacement',
          phase: 'finished',
        },
      }),
    );
    expect(staleMessage.state.items['message-1']).toEqual(message);
  });

  it('replaces a transcript epoch, clears old items, and ignores late events', () => {
    let state = createTranscriptProjection('s');
    state = applyTranscriptEvent(
      state,
      envelope(
        1,
        1,
        {
          type: 'message.finished',
          sessionId: 's',
          message: {
            messageId: 'old-message',
            role: 'assistant',
            content: 'old',
            phase: 'finished',
          },
        },
        'epoch-old',
      ),
    ).state;
    const replacement = applyTranscriptEvent(
      state,
      envelope(
        2,
        1,
        {
          type: 'message.updated',
          sessionId: 's-new',
          message: {
            messageId: 'new-message',
            role: 'assistant',
            content: 'new',
            phase: 'updated',
          },
        },
        'epoch-new',
        's-new',
      ),
    );
    expect(replacement.accepted).toBe(true);
    expect(replacement.state.order).toEqual(['new-message']);
    expect(replacement.state.items['old-message']).toBeUndefined();
    expect(replacement.state.sessionId).toBe('s-new');
    const late = applyTranscriptEvent(
      replacement.state,
      envelope(
        3,
        2,
        {
          type: 'message.updated',
          sessionId: 's-new',
          message: {
            messageId: 'late-message',
            role: 'assistant',
            content: 'late',
            phase: 'updated',
          },
        },
        'epoch-old',
        's-new',
      ),
    );
    expect(late.accepted).toBe(false);
    expect(late.reason).toBe('old-runtime-epoch');
    expect(late.state.order).toEqual(['new-message']);
  });

  it('replaces a runtime epoch and ignores a late retired runtime event', () => {
    let state = createRuntimeReducerState(snapshot(), {
      runtimeEpoch: 'epoch-old',
      runtimeSeq: 4,
      cursor: 4,
    });
    const replacement = applyRuntimeEvent(state, {
      cursor: 5,
      emittedAt: 5,
      runtimeEpoch: 'epoch-new',
      runtimeSeq: 1,
      event: {
        type: 'runtime.hello',
        protocolVersion: 1,
        snapshot: { ...snapshot(), liveState: 'working' },
      },
    });
    expect(replacement.accepted).toBe(true);
    state = replacement.state;
    expect(state.runtimeEpoch).toBe('epoch-new');
    expect(state.snapshot.liveState).toBe('working');
    const late = applyRuntimeEvent(state, {
      cursor: 6,
      emittedAt: 6,
      runtimeEpoch: 'epoch-old',
      runtimeSeq: 5,
      event: { type: 'agent.settled', sessionId: 's' },
    });
    expect(late.accepted).toBe(false);
    expect(late.reason).toBe('old-runtime-epoch');
    expect(late.state.snapshot.liveState).toBe('working');
  });

  it('selects the stable legacy raw-entry shape without recursive identity searches', () => {
    const state = hydrateTranscript([
      {
        type: 'message',
        id: 'entry-1',
        message: {
          id: 'message-1',
          role: 'assistant',
          timestamp: 123,
          content: [
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
          ],
          metadata: { id: 'must-not-be-used' },
        },
      },
    ]);
    const entries = selectLegacyTranscriptEntries(state);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      message: { id: 'message-1', content: [] },
    });
    expect(entries[1]).toMatchObject({ tool: { toolCallId: 'call-1' } });
    expect(JSON.stringify(entries)).not.toContain('must-not-be-used');
  });

  it('pairs an out-of-order persisted tool result without duplicate rendering', () => {
    const state = hydrateTranscript([
      {
        type: 'message',
        id: 'result-entry',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'file contents' }],
          isError: false,
        },
      },
      {
        type: 'message',
        id: 'assistant-entry',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'read',
              arguments: { path: 'file.txt' },
            },
          ],
        },
      },
    ]);
    expect(state.items['call-1']).toMatchObject({
      kind: 'tool',
      name: 'read',
      arguments: { path: 'file.txt' },
      result: [{ type: 'text', text: 'file contents' }],
      status: 'finished',
    });
    const entries = selectLegacyTranscriptEntries(state);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      tool: { toolCallId: 'call-1', result: [{ text: 'file contents' }] },
    });
    expect(entries[1]).toMatchObject({
      message: { id: 'assistant-entry', content: [] },
    });
  });
});
