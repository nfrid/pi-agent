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
  persistedEntriesToTranscriptEvents,
  persistedEntryToTranscriptEvents,
  projectTranscriptForRender,
  reduceTranscriptEvent,
  STEERING_MESSAGE_MARKER_TYPE,
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
  it('converts persisted messages, embedded tools, and tool results through the hydrate identities', () => {
    const entries = [
      {
        type: 'message',
        id: 'assistant-entry',
        timestamp: 100,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'answer' },
            {
              type: 'toolCall',
              toolCallId: 'embedded-call',
              name: 'read',
              arguments: { path: 'source.ts' },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'tool-result-entry',
        message: {
          role: 'toolResult',
          toolCallId: 'embedded-call',
          toolName: 'read',
          content: 'done',
          details: { lines: 3 },
        },
      },
    ];
    const events = entries.flatMap((entry, index) =>
      persistedEntryToTranscriptEvents(entry, 's', {
        fallbackEntryOffset: index,
      }),
    );
    let reduced = createTranscriptProjection('s');
    for (const event of events) reduced = reduceTranscriptEvent(reduced, event);
    const hydrated = hydrateTranscript(entries, 's');
    expect(reduced.order).toEqual(hydrated.order);
    expect(reduced.items).toMatchObject({
      'assistant-entry': { kind: 'message', status: 'finished' },
      'embedded-call': {
        kind: 'tool',
        result: { content: 'done', details: { lines: 3 } },
      },
    });
    expect(reduced.items['embedded-call']).toMatchObject(
      hydrated.items['embedded-call'],
    );
  });

  it('hydrates steering markers onto user messages without rendering marker rows', () => {
    const projection = hydrateTranscript([
      {
        type: 'custom',
        customType: STEERING_MESSAGE_MARKER_TYPE,
        data: { timestamp: 200, text: 'Steer this' },
        id: 'marker-1',
      },
      {
        type: 'message',
        id: 'user-1',
        message: { role: 'user', content: 'Steer this', timestamp: 200 },
      },
      {
        type: 'message',
        id: 'user-2',
        message: { role: 'user', content: 'Ordinary', timestamp: 200 },
      },
    ]);

    expect(projection.order).not.toContain('marker-1');
    expect(projectTranscriptForRender(projection).items).toMatchObject([
      { kind: 'message', messageId: 'user-1', deliveryMode: 'steer' },
      { kind: 'message', messageId: 'user-2' },
    ]);
    expect(
      projectTranscriptForRender(projection).items.some(
        (item) => item.kind === 'other',
      ),
    ).toBe(false);
  });

  it('keeps incremental persisted steering and fallback other identities parity-safe', () => {
    const entries = [
      {
        type: 'custom',
        customType: STEERING_MESSAGE_MARKER_TYPE,
        data: { timestamp: 200, text: 'Steer this' },
      },
      {
        type: 'message',
        message: { role: 'user', content: 'Steer this', timestamp: 200 },
      },
      { type: 'unrecognized', value: 'opaque' },
      'primitive-opaque',
    ];
    const events = persistedEntriesToTranscriptEvents(entries, 's', {
      fallbackEntryOffset: 10,
    });
    let reduced = createTranscriptProjection('s');
    for (const event of events) reduced = reduceTranscriptEvent(reduced, event);
    expect(projectTranscriptForRender(reduced).items).toMatchObject([
      { kind: 'message', messageId: 'entry-11', deliveryMode: 'steer' },
      { kind: 'other', id: 'entry-12', raw: entries[2] },
      { kind: 'other', id: 'entry-13', raw: entries[3] },
    ]);
    expect(reduced.order).toEqual(['entry-11', 'entry-12', 'entry-13']);
    expect(
      persistedEntriesToTranscriptEvents([entries[1]], 's', {
        fallbackEntryOffset: 11,
        steeringMarkers: [entries[0]],
      })[0],
    ).toMatchObject({
      type: 'message.finished',
      message: { data: { deliveryMode: 'steer' } },
    });
  });

  it('applies a live steering update to an already rendered user message', () => {
    let projection = createTranscriptProjection('s');
    projection = reduceTranscriptEvent(projection, {
      type: 'message.started',
      sessionId: 's',
      message: {
        messageId: 'user-live',
        role: 'user',
        content: 'Redirect live work',
        phase: 'started',
      },
    });
    projection = reduceTranscriptEvent(projection, {
      type: 'message.updated',
      sessionId: 's',
      message: {
        messageId: 'user-live',
        role: 'user',
        content: 'Redirect live work',
        phase: 'updated',
        data: { deliveryMode: 'steer' },
      },
    });
    expect(projectTranscriptForRender(projection).items[0]).toMatchObject({
      kind: 'message',
      messageId: 'user-live',
      deliveryMode: 'steer',
    });
  });

  it('does not infer steering from a timestamp without a durable marker', () => {
    const [item] = projectTranscriptForRender(
      hydrateTranscript([
        {
          type: 'message',
          id: 'user-1',
          message: { role: 'user', content: 'Ordinary', timestamp: 200 },
        },
        {
          type: 'custom',
          customType: STEERING_MESSAGE_MARKER_TYPE,
          data: { timestamp: 200, text: 'Different text' },
        },
      ]),
    ).items;
    expect(item).toMatchObject({ kind: 'message' });
    expect(item?.kind === 'message' ? item.deliveryMode : undefined).toBe(
      undefined,
    );
  });

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

  it('omits duplicate live toolResult messages like persisted hydration', () => {
    let state = hydrateTranscript([], 's');
    state = reduceTranscriptEvent(state, {
      type: 'tool.finished',
      sessionId: 's',
      tool: {
        toolCallId: 'call-1',
        name: 'read',
        result: 'done',
        status: 'completed',
      },
    });
    state = reduceTranscriptEvent(state, {
      type: 'message.started',
      sessionId: 's',
      message: {
        messageId: 'tool-result-message',
        role: 'toolResult',
        content: [{ type: 'text', text: 'done' }],
      },
    });
    state = reduceTranscriptEvent(state, {
      type: 'message.finished',
      sessionId: 's',
      message: {
        messageId: 'tool-result-message',
        role: 'toolResult',
        content: [{ type: 'text', text: 'done' }],
      },
    });

    expect(state.order).toEqual(['call-1']);
    expect(state.items['tool-result-message']).toBeUndefined();
    expect(state.items['call-1']).toMatchObject({
      kind: 'tool',
      result: 'done',
      status: 'finished',
    });
  });

  it('retains structured tool result envelopes across live updates and snapshots', () => {
    const result = {
      content: [{ type: 'text', text: 'structured delegate handoff' }],
      details: {
        mode: 'single',
        runs: [{ name: 'Audit' }],
      },
    };
    let state = hydrateTranscript([], 's');
    state = applyTranscriptEvent(
      state,
      envelope(1, 1, {
        type: 'tool.finished',
        sessionId: 's',
        tool: {
          toolCallId: 'delegate-call',
          name: 'delegate',
          result,
          status: 'completed',
        },
      }),
    ).state;
    expect(state.items['delegate-call']).toMatchObject({
      name: 'delegate',
      result,
    });

    state = applyTranscriptEvent(state, {
      cursor: 2,
      emittedAt: 2,
      runtimeId: 'r',
      runtimeEpoch: 'epoch-1',
      runtimeSeq: 2,
      sessionId: 's',
      event: {
        type: 'session.snapshot',
        session: {
          id: 's',
          entriesComplete: true,
          entries: [
            {
              type: 'message',
              message: {
                role: 'toolResult',
                toolCallId: 'delegate-call',
                toolName: 'delegate',
                content: result.content,
                details: result.details,
              },
            },
          ],
        },
      },
    } as never).state;
    expect(state.items['delegate-call']).toMatchObject({
      name: 'delegate',
      result,
      status: 'finished',
    });
  });

  it('appends a completed compaction entry without replacing the transcript', () => {
    const initial = hydrateTranscript(
      [
        {
          type: 'message',
          id: 'prompt-1',
          message: { role: 'user', content: 'Keep this message.' },
        },
      ],
      's',
    );
    const state = applyTranscriptEvent(initial, {
      cursor: 1,
      emittedAt: 1,
      sessionId: 's',
      event: {
        type: 'session.compacted',
        sessionId: 's',
        entry: {
          type: 'compaction',
          id: 'compact-1',
          summary: 'Earlier work.',
        },
      },
    }).state;

    expect(state.order).toEqual(['prompt-1', 'compact-1']);
    expect(state.items['prompt-1']).toBeDefined();
    expect(state.items['compact-1']).toMatchObject({
      kind: 'other',
      raw: { type: 'compaction', summary: 'Earlier work.' },
    });
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

  it('inserts delayed older messages and owned tools into transcript chronology', () => {
    let state = hydrateTranscript(
      [
        { type: 'custom_message', id: 'opaque-boundary', text: 'boundary' },
        {
          type: 'message',
          id: 'persisted-newer',
          message: {
            role: 'assistant',
            content: 'newer answer',
            timestamp: '2024-06-01T13:00:00.000Z',
          },
        },
      ],
      's',
    );
    state = reduceTranscriptEvent(state, {
      type: 'message.updated',
      sessionId: 's',
      message: {
        messageId: 'active-older',
        role: 'assistant',
        content: 'older answer',
        timestamp: 1717243200000,
        turnId: 'turn-older',
        toolCallIds: ['active-tool'],
      },
    });
    state = reduceTranscriptEvent(state, {
      type: 'tool.updated',
      sessionId: 's',
      tool: {
        toolCallId: 'active-tool',
        name: 'search',
        status: 'running',
        turnId: 'turn-older',
      },
    });

    expect(state.order).toEqual([
      'opaque-boundary',
      'active-older',
      'active-tool',
      'persisted-newer',
    ]);
    const beforeUpdate = state.order;
    state = reduceTranscriptEvent(state, {
      type: 'message.updated',
      sessionId: 's',
      message: {
        messageId: 'active-older',
        role: 'assistant',
        content: 'older answer updated',
        timestamp: '1717243200000',
        phase: 'updated',
      },
    });
    expect(state.order).toBe(beforeUpdate);
    expect(state.items['active-older']).toMatchObject({
      content: 'older answer updated',
      timestamp: '1717243200000',
    });
  });

  it('inherits tool chronology and preserves ownerless equal-anchor order', () => {
    let ownerProjection = hydrateTranscript([], 's');
    ownerProjection = reduceTranscriptEvent(ownerProjection, {
      type: 'message.updated',
      sessionId: 's',
      message: {
        messageId: 'retired-owner',
        role: 'assistant',
        content: 'older response',
        timestamp: 100,
        toolCallIds: ['delayed-a', 'delayed-b'],
      },
    });
    ownerProjection = reduceTranscriptEvent(ownerProjection, {
      type: 'tool.updated',
      sessionId: 's',
      tool: { toolCallId: 'delayed-a', name: 'read', status: 'running' },
    });
    ownerProjection = reduceTranscriptEvent(ownerProjection, {
      type: 'tool.updated',
      sessionId: 's',
      tool: { toolCallId: 'delayed-b', name: 'grep', status: 'running' },
    });
    expect(ownerProjection.items['delayed-a']).toMatchObject({
      timestamp: 100,
    });
    expect(ownerProjection.items['delayed-b']).toMatchObject({
      timestamp: 100,
    });

    let state = hydrateTranscript(
      [
        {
          type: 'message',
          id: 'persisted-assistant-newer',
          message: { role: 'assistant', content: 'newer', timestamp: 200 },
        },
        {
          type: 'message',
          id: 'persisted-user-newer',
          message: { role: 'user', content: 'follow-up', timestamp: 220 },
        },
      ],
      's',
    );
    state = reduceTranscriptEvent(state, {
      type: 'message.updated',
      sessionId: 's',
      message: {
        messageId: 'active-message',
        role: 'assistant',
        content: 'current response',
        timestamp: 150,
      },
    });
    for (const toolCallId of ['delayed-a', 'delayed-b']) {
      const tool = ownerProjection.items[toolCallId];
      if (tool?.kind !== 'tool') throw new Error('missing inherited tool');
      state = reduceTranscriptEvent(state, {
        type: 'tool.updated',
        sessionId: 's',
        tool: {
          toolCallId,
          name: tool.name,
          status: 'finished',
          timestamp: tool.timestamp,
        },
      });
    }

    expect(state.order).toEqual([
      'delayed-a',
      'delayed-b',
      'active-message',
      'persisted-assistant-newer',
      'persisted-user-newer',
    ]);
  });

  it('fails closed for missing, invalid, and equal timestamps', () => {
    const initial = hydrateTranscript(
      [
        { type: 'custom_message', id: 'opaque-boundary', text: 'boundary' },
        {
          type: 'message',
          id: 'persisted-newer',
          message: { role: 'assistant', content: 'newer', timestamp: 200 },
        },
      ],
      's',
    );
    let state = reduceTranscriptEvent(initial, {
      type: 'message.updated',
      sessionId: 's',
      message: {
        messageId: 'missing-timestamp',
        role: 'assistant',
        content: 'unknown chronology',
      },
    });
    state = reduceTranscriptEvent(state, {
      type: 'message.updated',
      sessionId: 's',
      message: {
        messageId: 'invalid-timestamp',
        role: 'assistant',
        content: 'invalid chronology',
        timestamp: 'not-a-date',
      },
    });
    state = reduceTranscriptEvent(state, {
      type: 'message.updated',
      sessionId: 's',
      message: {
        messageId: 'equal-timestamp',
        role: 'assistant',
        content: 'equal chronology',
        timestamp: '200',
      },
    });

    expect(state.order).toEqual([
      'opaque-boundary',
      'persisted-newer',
      'missing-timestamp',
      'invalid-timestamp',
      'equal-timestamp',
    ]);
  });

  it('scans past unknown and equal rows to the first later timestamp anchor', () => {
    const initial = hydrateTranscript(
      [
        { type: 'custom_message', id: 'opaque-before', text: 'boundary' },
        {
          type: 'message',
          id: 'missing-before',
          message: { role: 'assistant', content: 'unknown before' },
        },
        {
          type: 'message',
          id: 'equal-before',
          message: {
            role: 'assistant',
            content: 'equal before',
            timestamp: 100,
          },
        },
        {
          type: 'message',
          id: 'later-anchor',
          message: { role: 'assistant', content: 'later', timestamp: 200 },
        },
        {
          type: 'message',
          id: 'missing-after',
          message: { role: 'assistant', content: 'unknown after' },
        },
      ],
      's',
    );
    const state = reduceTranscriptEvent(initial, {
      type: 'message.updated',
      sessionId: 's',
      message: {
        messageId: 'between',
        role: 'assistant',
        content: 'between timestamps',
        timestamp: 150,
      },
    });

    expect(state.order).toEqual([
      'opaque-before',
      'missing-before',
      'equal-before',
      'between',
      'later-anchor',
      'missing-after',
    ]);
  });

  it('does not compare synthetic scalar clocks with ISO epoch timestamps', () => {
    const initial = hydrateTranscript(
      [
        {
          type: 'message',
          id: 'iso-user',
          message: {
            role: 'user',
            content: 'persisted user',
            timestamp: '2026-08-04T12:00:00.000Z',
          },
        },
      ],
      's',
    );
    const state = reduceTranscriptEvent(initial, {
      type: 'message.updated',
      sessionId: 's',
      message: {
        messageId: 'synthetic-assistant',
        role: 'assistant',
        content: 'synthetic live response',
        timestamp: 1005,
      },
    });

    expect(state.order).toEqual(['iso-user', 'synthetic-assistant']);
  });

  it('uses a nonempty turn ID to place an otherwise unowned tool', () => {
    let state = hydrateTranscript([], 's');
    state = reduceTranscriptEvent(state, {
      type: 'message.updated',
      sessionId: 's',
      message: {
        messageId: 'turn-message',
        role: 'assistant',
        content: 'working',
        turnId: 'turn-1',
      },
    });
    state = reduceTranscriptEvent(state, {
      type: 'tool.updated',
      sessionId: 's',
      tool: {
        toolCallId: 'turn-tool',
        name: 'read',
        status: 'running',
        turnId: 'turn-1',
      },
    });
    expect(state.order).toEqual(['turn-message', 'turn-tool']);
  });

  it('projects canonical render IDs, pairing, lifecycle, and streaming state', () => {
    let state = hydrateTranscript([], 's');
    state = reduceTranscriptEvent(state, {
      type: 'message.started',
      sessionId: 's',
      message: {
        messageId: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Inspecting files.' }],
        toolCallIds: ['call-1'],
      },
    });
    state = reduceTranscriptEvent(state, {
      type: 'tool.updated',
      sessionId: 's',
      tool: {
        toolCallId: 'call-1',
        name: 'read',
        status: 'running',
      },
    });
    const rendered = projectTranscriptForRender(state).items;
    expect(rendered).toEqual([
      expect.objectContaining({
        kind: 'message',
        key: 'assistant-1',
        toolCallIds: ['call-1'],
        associatedToolCallIds: ['call-1'],
        streaming: true,
        preparing: false,
      }),
      expect.objectContaining({
        kind: 'tool',
        key: 'call-1',
        status: 'running',
      }),
    ]);

    const preparing = projectTranscriptForRender(
      reduceTranscriptEvent(hydrateTranscript([], 's'), {
        type: 'message.started',
        sessionId: 's',
        message: {
          messageId: 'assistant-2',
          role: 'assistant',
          content: 'Preparing.',
        },
      }),
    ).items;
    expect(preparing[0]).toMatchObject({
      kind: 'message',
      streaming: true,
      preparing: true,
    });

    const embedded = projectTranscriptForRender(
      reduceTranscriptEvent(hydrateTranscript([], 's'), {
        type: 'message.updated',
        sessionId: 's',
        message: {
          messageId: 'assistant-3',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading.' },
            { type: 'toolCall', id: 'call-3', name: 'read' },
          ],
        },
      }),
    ).items;
    expect(embedded).toMatchObject([
      {
        kind: 'message',
        content: [{ type: 'text', text: 'Reading.' }],
        associatedToolCallIds: ['call-3'],
        preparing: false,
      },
      { kind: 'tool', toolCallId: 'call-3', status: 'pending' },
    ]);
  });

  it('projects phased live custom messages as their persisted entry shape', () => {
    let state = hydrateTranscript([], 's');
    state = reduceTranscriptEvent(state, {
      type: 'message.started',
      sessionId: 's',
      message: {
        messageId: 'custom-1',
        role: 'custom',
        content: '# Background delegate job',
        phase: 'started',
        data: {
          customType: 'delegate-job-result',
          display: true,
          details: { jobs: [{ name: 'Review', state: 'success' }] },
        },
      },
    } as never);
    state = reduceTranscriptEvent(state, {
      type: 'message.updated',
      sessionId: 's',
      message: {
        messageId: 'custom-1',
        role: 'custom',
        content: '# Background delegate job dj-1',
        phase: 'updated',
        data: { display: false },
      },
    } as never);
    state = reduceTranscriptEvent(state, {
      type: 'message.finished',
      sessionId: 's',
      message: {
        messageId: 'custom-1',
        role: 'custom',
        content: '# Background delegate job dj-1 (Review) success',
        phase: 'finished',
      },
    } as never);

    expect(
      projectTranscriptForRender(state, { includeSessionEvents: true }).items,
    ).toEqual([
      {
        kind: 'other',
        key: 'custom-1',
        id: 'custom-1',
        raw: {
          type: 'custom_message',
          customType: 'delegate-job-result',
          content: '# Background delegate job dj-1 (Review) success',
          display: false,
          details: { jobs: [{ name: 'Review', state: 'success' }] },
        },
      },
    ]);
  });

  it('hides live context-only custom messages without persisted metadata', () => {
    let state = hydrateTranscript([], 's');
    for (const [messageId, content, data] of [
      [
        'todo-snapshot',
        'Todo state at the start of this user turn (1 active, 0 ready, 0 blocked, 0 done).',
        undefined,
      ],
      ['hidden-context', 'Provider-only context', { display: false }],
    ] as const) {
      state = reduceTranscriptEvent(state, {
        type: 'message.finished',
        sessionId: 's',
        message: {
          messageId,
          role: 'custom',
          content,
          phase: 'finished',
          ...(data ? { data } : {}),
        },
      } as never);
    }

    expect(projectTranscriptForRender(state).items).toEqual([]);
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

  it('accepts a low first tagged sequence after untagged events', () => {
    let state = hydrateTranscript([], 's');
    state = reduceTranscriptEvent(state, {
      cursor: 1,
      emittedAt: 1,
      runtimeSeq: 99,
      sessionId: 's',
      event: { type: 'agent.settled', sessionId: 's' },
    } as never);
    state = reduceTranscriptEvent(state, {
      cursor: 2,
      emittedAt: 2,
      runtimeEpoch: 'epoch-first',
      runtimeSeq: 1,
      sessionId: 's',
      event: { type: 'agent.settled', sessionId: 's' },
    } as never);

    expect(state.runtimeEpoch).toBe('epoch-first');
    expect(state.lastRuntimeSeq).toBe(1);
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

  it('invalidates a complete runtime branch with a bounded session patch', () => {
    const state = createRuntimeReducerState({
      ...snapshot(),
      session: {
        id: 's',
        file: '/tmp/session.jsonl',
        name: 'Session',
        title: 'Session title',
        cwd: '/tmp',
        leafId: 'stale-leaf',
        entriesComplete: true,
        entries: [{ type: 'message', id: 'stale-entry' }],
      },
    });
    const result = applyRuntimeEvent(state, {
      event: {
        type: 'runtime.stateChanged',
        state: 'idle',
        snapshot: {
          session: {
            id: 's',
            file: '/tmp/session.jsonl',
            name: 'Session',
            title: 'Session title',
            cwd: '/tmp',
            entries: [],
            entriesComplete: false,
          },
        },
      },
      runtimeSeq: 1,
    });
    expect(result.accepted).toBe(true);
    expect(result.state.snapshot.session).toEqual({
      id: 's',
      file: '/tmp/session.jsonl',
      name: 'Session',
      title: 'Session title',
      cwd: '/tmp',
      entries: [],
      entriesComplete: false,
    });
  });

  it('merges live queue and extension surface patches without dropping either', () => {
    const state = createRuntimeReducerState({
      ...snapshot(),
      modelCatalog: [{ provider: 'old', model: 'old' }],
      thinkingLevels: ['off'],
      queueDrafts: [{ clientId: 'old', mode: 'steer', text: 'replace me' }],
      extensionSurfaces: [],
    });
    const result = applyRuntimeEvent(state, {
      event: {
        type: 'runtime.stateChanged',
        state: 'working',
        snapshot: {
          modelCatalog: [{ provider: 'configured', model: 'current' }],
          thinkingLevels: ['off', 'medium'],
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
    expect(result.state.snapshot.modelCatalog).toEqual([
      { provider: 'configured', model: 'current' },
    ]);
    expect(result.state.snapshot.thinkingLevels).toEqual(['off', 'medium']);
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

  it('preserves full delegate transcripts across compact patches and applies upserts', () => {
    const fullSurface = {
      id: 'delegate.status',
      rendererId: 'delegate.status',
      viewModel: {
        version: 1,
        statuses: [
          {
            id: 'ds-1',
            runId: 'run-1',
            lineageId: 'lineage-1',
            name: 'Worker',
            kind: 'background',
            state: 'running',
            createdAt: 1,
            allowWrites: false,
            transcript: [
              {
                id: 'task',
                type: 'task',
                label: 'Task',
                text: 'inspect source',
                status: 'completed',
              },
            ],
          },
        ],
      },
    };
    let state = createRuntimeReducerState({
      ...snapshot(),
      session: { ...snapshot().session, id: 'session-1' },
      extensionSurfaces: [fullSurface],
    });
    const compact = applyRuntimeEvent(state, {
      event: {
        type: 'runtime.stateChanged',
        state: 'working',
        snapshot: {
          extensionSurfaces: [
            {
              ...fullSurface,
              viewModel: {
                ...fullSurface.viewModel,
                statuses: [
                  {
                    ...fullSurface.viewModel.statuses[0],
                    activity: {
                      type: 'tool',
                      label: 'read source.ts',
                      status: 'running',
                    },
                    transcriptTruncated: true,
                  },
                ],
              },
            },
          ],
        },
      },
      runtimeSeq: 1,
    });
    expect(compact.accepted).toBe(true);
    state = compact.state;
    const upsert = applyRuntimeEvent(state, {
      event: {
        type: 'delegate.transcript.updated',
        sessionId: 'session-1',
        lineageId: 'lineage-1',
        runId: 'run-1',
        entry: {
          id: 'tool-1',
          type: 'tool',
          label: 'read source.ts',
          name: 'read',
          status: 'completed',
          result: { lines: 3 },
        },
      },
      runtimeSeq: 2,
    });
    expect(upsert.accepted).toBe(true);
    expect(
      upsert.state.snapshot.extensionSurfaces?.[0]?.viewModel,
    ).toMatchObject({
      statuses: [
        {
          transcript: [
            { id: 'task', text: 'inspect source' },
            { id: 'tool-1', result: { lines: 3 } },
          ],
        },
      ],
    });
  });

  it('retains first transcript upserts after a new delegate metadata patch', () => {
    let state = createRuntimeReducerState({
      ...snapshot(),
      session: { ...snapshot().session, id: 'session-new' },
      extensionSurfaces: [],
    });
    const metadata = applyRuntimeEvent(state, {
      event: {
        type: 'runtime.stateChanged',
        state: 'working',
        snapshot: {
          extensionSurfaces: [
            {
              id: 'delegate.status',
              rendererId: 'delegate.status',
              viewModel: {
                version: 1,
                statuses: [
                  {
                    id: 'ds-new',
                    runId: 'run-new',
                    lineageId: 'lineage-new',
                    name: 'Worker',
                    kind: 'background',
                    state: 'running',
                    createdAt: 1,
                    allowWrites: false,
                  },
                ],
              },
            },
          ],
        },
      },
      runtimeSeq: 1,
    });
    expect(metadata.accepted).toBe(true);
    state = metadata.state;
    for (const [runtimeSeq, entry] of [
      [2, { id: 'task', type: 'task', label: 'Task', text: 'inspect' }],
      [
        3,
        { id: 'tool-1', type: 'tool', label: 'read source', status: 'running' },
      ],
    ] as const) {
      const update = applyRuntimeEvent(state, {
        event: {
          type: 'delegate.transcript.updated',
          sessionId: 'session-new',
          lineageId: 'lineage-new',
          runId: 'run-new',
          entry,
        },
        runtimeSeq,
      });
      expect(update.accepted).toBe(true);
      state = update.state;
    }
    expect(state.snapshot.extensionSurfaces?.[0]?.viewModel).toMatchObject({
      statuses: [
        {
          runId: 'run-new',
          transcript: [
            { id: 'task', text: 'inspect' },
            { id: 'tool-1', status: 'running' },
          ],
        },
      ],
    });
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
