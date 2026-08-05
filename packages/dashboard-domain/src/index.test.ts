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
  reduceTranscriptEvent,
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

  it('keeps already-running protocol-v1 wrappers functional without recursive identity search', () => {
    let state = hydrateTranscript([], 's');
    state = reduceTranscriptEvent(state, {
      type: 'message.started',
      sessionId: 's',
      message: {
        message: {
          role: 'assistant',
          timestamp: 123,
          content: [{ type: 'text', text: 'start' }],
          metadata: { id: 'must-not-be-an-identity' },
        },
      },
    });
    state = reduceTranscriptEvent(state, {
      type: 'message.updated',
      sessionId: 's',
      message: {
        message: {
          role: 'assistant',
          timestamp: 123,
          content: [{ type: 'text', text: 'updated' }],
        },
      },
    });
    state = reduceTranscriptEvent(state, {
      type: 'tool.finished',
      sessionId: 's',
      tool: {
        toolCallId: 'call-legacy',
        toolName: 'read',
        args: { path: 'file.txt' },
        result: 'contents',
      },
    });
    expect(state.items['assistant:123']).toMatchObject({
      content: [{ type: 'text', text: 'updated' }],
    });
    expect(state.items['call-legacy']).toMatchObject({
      name: 'read',
      arguments: { path: 'file.txt' },
      result: 'contents',
    });
    expect(state.items['must-not-be-an-identity']).toBeUndefined();
  });

  it('keeps a raw active message identity when finish adds responseId late', () => {
    let state = hydrateTranscript([], 's');
    state = reduceTranscriptEvent(state, {
      type: 'message.started',
      sessionId: 's',
      message: {
        message: {
          role: 'assistant',
          timestamp: 123,
          content: 'start',
        },
      },
    });
    state = reduceTranscriptEvent(state, {
      type: 'message.finished',
      sessionId: 's',
      responseId: 'provider-response',
      message: {
        message: { role: 'assistant', content: 'finish' },
      },
    } as never);
    expect(state.order).toEqual(['assistant:123']);
    expect(state.items['assistant:123']).toMatchObject({
      status: 'finished',
      content: 'finish',
    });
    expect(state.items['provider-response']).toBeUndefined();
  });

  it('derives tool associations from normalized live message content', () => {
    const state = reduceTranscriptEvent(
      hydrateTranscript([], 's'),
      envelope(1, 1, {
        type: 'message.finished',
        sessionId: 's',
        message: {
          messageId: 'assistant-normalized',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Inspecting files.' },
            { type: 'toolCall', id: 'call-normalized', name: 'read' },
          ],
          phase: 'finished',
        },
      }),
    );
    expect(state.items['assistant-normalized']).toMatchObject({
      toolCallIds: ['call-normalized'],
    });
  });

  it('preserves direct tool associations and skips only Pi metadata', () => {
    const state = hydrateTranscript([
      { type: 'session_info', id: 'meta' },
      {
        type: 'message',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Inspecting files.' },
            { type: 'toolCall', id: 'call-1', name: 'read' },
          ],
        },
      },
      { type: 'tool', tool: { toolCallId: 'call-1', name: 'read' } },
      { type: 'custom_message', text: 'boundary' },
      { type: 'future_entry', text: 'unknown boundary' },
    ]);
    expect(state.items['assistant-1']).toMatchObject({
      toolCallIds: ['call-1'],
    });
    const selected = selectLegacyTranscriptEntries(state);
    expect(selected.map((entry) => (entry as { type?: string }).type)).toEqual([
      'message',
      'tool',
      'custom_message',
      'future_entry',
    ]);
    expect(
      (selected[0] as { message: { content: unknown[] } }).message.content,
    ).toEqual([{ type: 'text', text: 'Inspecting files.' }]);
  });

  it('replaces the transcript only for complete session snapshots', () => {
    let state = hydrateTranscript([], 's');
    state = reduceTranscriptEvent(
      state,
      envelope(1, 1, {
        type: 'message.finished',
        sessionId: 's',
        message: {
          messageId: 'old',
          role: 'assistant',
          content: 'old',
          phase: 'finished',
        },
      }),
    );
    const incomplete = reduceTranscriptEvent(state, {
      cursor: 2,
      emittedAt: 2,
      runtimeEpoch: 'epoch-2',
      runtimeSeq: 2,
      event: {
        type: 'session.snapshot',
        session: { id: 's', entries: [], entriesComplete: false },
      },
    } as never);
    expect(incomplete.items.old).toBeDefined();
    expect(incomplete.runtimeEpoch).toBe('epoch-2');
    expect(incomplete.retiredEpochs).toContain('epoch-1');
    const complete = reduceTranscriptEvent(incomplete, {
      cursor: 3,
      emittedAt: 3,
      runtimeEpoch: 'epoch-2',
      runtimeSeq: 3,
      event: {
        type: 'session.snapshot',
        session: {
          id: 's',
          entriesComplete: true,
          entries: [
            {
              type: 'message',
              message: { id: 'new', role: 'user', content: 'new' },
            },
          ],
        },
      },
    } as never);
    expect(complete.items.old).toBeUndefined();
    expect(complete.items.new).toMatchObject({ role: 'user' });
    expect(complete.lastCursor).toBe(3);
    expect(complete.lastRuntimeSeq).toBe(3);
    expect(complete.runtimeEpoch).toBe('epoch-2');
    expect(complete.retiredEpochs).toContain('epoch-1');
  });

  it('normalizes terminal tool status aliases on update events', () => {
    for (const status of ['complete', 'completed', 'finished'] as const) {
      const state = applyTranscriptEvent(
        hydrateTranscript([], 's'),
        envelope(1, 1, {
          type: 'tool.updated',
          sessionId: 's',
          tool: {
            toolCallId: `call-${status}`,
            name: 'read',
            status,
            phase: 'updated',
          },
        }),
      ).state;
      expect(state.items[`call-${status}`]).toMatchObject({
        kind: 'tool',
        status: 'finished',
      });
    }
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

  it('merges live queue and extension surface patches without dropping either', () => {
    const state = createRuntimeReducerState({
      ...snapshot(),
      queueDrafts: [{ clientId: 'old', mode: 'steer', text: 'replace me' }],
      extensionSurfaces: [],
    });
    const result = applyRuntimeEvent(state, {
      event: {
        type: 'runtime.stateChanged',
        state: 'working',
        snapshot: {
          queueDrafts: [
            { clientId: 'draft-1', mode: 'followUp', text: 'run later' },
          ],
          extensionSurfaces: [
            {
              id: 'tasks.current',
              rendererId: 'tasks.current',
              viewModel: { version: 1, tasks: [] },
            },
          ],
        },
      },
      runtimeSeq: 1,
    });
    expect(result.accepted).toBe(true);
    expect(result.state.snapshot.queueDrafts).toEqual([
      { clientId: 'draft-1', mode: 'followUp', text: 'run later' },
    ]);
    expect(result.state.snapshot.extensionSurfaces).toEqual([
      {
        id: 'tasks.current',
        rendererId: 'tasks.current',
        viewModel: { version: 1, tasks: [] },
      },
    ]);
  });

  it('fails closed on duplicate capability patches and accepts later valid updates', () => {
    const initialCapabilities = {
      version: 1 as const,
      capabilities: [{ id: 'initial', version: '1' }],
      manifests: [],
    };
    let state = createRuntimeReducerState({
      ...snapshot(),
      capabilities: initialCapabilities,
    });
    const invalid = applyRuntimeEvent(state, {
      event: {
        type: 'runtime.heartbeat',
        state: 'working',
        snapshot: {
          capabilities: {
            version: 1,
            capabilities: [
              { id: 'duplicate', version: '1' },
              { id: 'duplicate', version: '2' },
            ],
            manifests: [],
          },
        },
      },
      runtimeSeq: 1,
    } as never);
    expect(invalid.accepted).toBe(false);
    expect(invalid.reason).toBe('invalid-capabilities');
    expect(invalid.state).toBe(state);

    const valid = applyRuntimeEvent(state, {
      event: {
        type: 'runtime.stateChanged',
        state: 'working',
        snapshot: {
          capabilities: {
            version: 1,
            capabilities: [{ id: 'updated', version: '1' }],
            manifests: [],
          },
        },
      },
      runtimeSeq: 2,
    } as never);
    expect(valid.accepted).toBe(true);
    state = valid.state;
    expect(state.snapshot.capabilities?.capabilities).toEqual([
      { id: 'updated', version: '1' },
    ]);
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

  it('hydrates direct session messages like wrapped entries in either replay order', () => {
    for (const resultFirst of [true, false]) {
      for (const isError of [false, true]) {
        const user = {
          id: 'user-direct',
          role: 'user',
          content: 'Inspect this.',
        };
        const assistant = {
          id: 'assistant-direct',
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call-direct',
              name: 'read',
              arguments: { path: 'file.txt' },
            },
          ],
        };
        const result = {
          id: 'result-direct',
          role: 'toolResult',
          toolCallId: 'call-direct',
          toolName: 'read',
          content: [{ type: 'text', text: isError ? 'nope' : 'ok' }],
          isError,
        };
        const ordered = resultFirst
          ? [user, result, result, assistant]
          : [user, assistant, result, result];
        const direct = hydrateTranscript(ordered);
        const wrapped = hydrateTranscript(
          ordered.map((message) => ({ type: 'message', message })),
        );
        expect(direct).toEqual(wrapped);
        expect(direct.items['user-direct']).toMatchObject({
          kind: 'message',
          role: 'user',
          content: 'Inspect this.',
        });
        expect(direct.items['call-direct']).toMatchObject({
          kind: 'tool',
          name: 'read',
          arguments: { path: 'file.txt' },
          result: [{ type: 'text', text: isError ? 'nope' : 'ok' }],
          status: isError ? 'error' : 'finished',
          isError,
        });
        expect(selectLegacyTranscriptEntries(direct)).toHaveLength(3);
      }
    }
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
