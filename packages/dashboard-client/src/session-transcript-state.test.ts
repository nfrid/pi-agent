import { hydrateTranscript } from '@pi-dashboard/domain';
import type {
  AuthoritativeSessionSnapshot,
  DashboardEventEnvelope,
} from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  classifyHistoryPageWatermark,
  installAuthoritativeTranscript,
  mergeLatestTranscript,
  mergePrependedTranscript,
  persistedMessageIdForLive,
  reduceSessionTranscriptEvent,
} from './session-transcript-state.js';

describe('session transcript state', () => {
  it('classifies exact, ahead, stale, and incoherent history cuts', () => {
    const current = { generation: 3, sequence: 7, sequenceKnown: true };
    const response = (cursor: number) =>
      ({ cursor }) as AuthoritativeSessionSnapshot;

    expect(classifyHistoryPageWatermark(current, [response(7)])).toEqual({
      status: 'ready',
      sequence: 7,
    });
    expect(classifyHistoryPageWatermark(current, [response(8)])).toEqual({
      status: 'ahead',
      sequence: 8,
    });
    expect(classifyHistoryPageWatermark(current, [response(6)])).toEqual({
      status: 'stale',
      sequence: 6,
    });
    expect(
      classifyHistoryPageWatermark(current, [response(7), response(8)]),
    ).toEqual({ status: 'incoherent' });
  });

  it('keeps a live message newer than a delayed authoritative session snapshot', () => {
    const live = reduceSessionTranscriptEvent(
      hydrateTranscript([], 'session-1'),
      'session-1',
      {
        cursor: 5,
        emittedAt: 5,
        sessionId: 'session-1',
        runtimeEpoch: 'runtime-1',
        event: {
          type: 'message.updated',
          sessionId: 'session-1',
          message: {
            messageId: 'first-user-message',
            role: 'user',
            content: 'First prompt',
            timestamp: 5,
          },
        },
      } as DashboardEventEnvelope,
    );
    expect(live?.order).toContain('first-user-message');

    const installed = installAuthoritativeTranscript({
      response: {
        metadata: { id: 'session-1', file: '', cwd: '/tmp', updatedAt: 1 },
        entries: [
          {
            type: 'message',
            id: 'persisted-first-user-message',
            message: {
              role: 'user',
              content: 'First prompt',
              timestamp: 5,
            },
          },
        ],
        entriesComplete: true,
        serverId: 'server-1',
        runtimeEpoch: 'runtime-1',
        cursor: 4,
      } as unknown as AuthoritativeSessionSnapshot,
      previousProjection: live,
      generation: 1,
      serverId: 'server-1',
      coveredCursor: 4,
      replace: true,
    });

    expect(installed.projection.order).toEqual([
      'persisted-first-user-message',
    ]);
  });

  it('keeps the latest live update when a snapshot reuses its message ID', () => {
    const previous = hydrateTranscript(
      [
        {
          type: 'message',
          id: 'stable-message-id',
          message: { role: 'user', content: 'Updated prompt' },
        },
      ],
      'session-1',
      { cursor: 5 },
    );
    const installed = installAuthoritativeTranscript({
      response: {
        metadata: { id: 'session-1', file: '', cwd: '/tmp', updatedAt: 1 },
        entries: [
          {
            type: 'message',
            id: 'stable-message-id',
            message: { role: 'user', content: 'Earlier prompt' },
          },
        ],
        entriesComplete: true,
        serverId: 'server-1',
        cursor: 4,
      } as unknown as AuthoritativeSessionSnapshot,
      previousProjection: previous,
      generation: 1,
      serverId: 'server-1',
      coveredCursor: 4,
      replace: true,
    });

    expect(installed.projection.order).toEqual(['stable-message-id']);
    expect(installed.projection.items['stable-message-id']).toMatchObject({
      content: 'Updated prompt',
    });
  });

  it('lets a newer authoritative replacement remove stale live messages', () => {
    const previous = hydrateTranscript(
      [
        {
          type: 'message',
          id: 'stale-message',
          message: { role: 'user', content: 'Stale branch' },
        },
      ],
      'session-1',
      { cursor: 5, runtimeEpoch: 'runtime-1' },
    );
    const installed = installAuthoritativeTranscript({
      response: {
        metadata: { id: 'session-1', file: '', cwd: '/tmp', updatedAt: 1 },
        entries: [
          {
            type: 'message',
            id: 'authoritative-message',
            message: { role: 'user', content: 'Rewritten branch' },
          },
        ],
        entriesComplete: true,
        serverId: 'server-1',
        runtimeEpoch: 'runtime-1',
        cursor: 6,
      } as unknown as AuthoritativeSessionSnapshot,
      previousProjection: previous,
      generation: 1,
      serverId: 'server-1',
      coveredCursor: 6,
      replace: true,
    });

    expect(installed.projection.order).toEqual(['authoritative-message']);
  });

  it('does not preserve live entries across a runtime epoch change', () => {
    const previous = hydrateTranscript(
      [
        {
          type: 'message',
          id: 'old-runtime-message',
          message: { role: 'user', content: 'Old runtime' },
        },
      ],
      'session-1',
      { cursor: 5, runtimeEpoch: 'runtime-old' },
    );
    const installed = installAuthoritativeTranscript({
      response: {
        metadata: { id: 'session-1', file: '', cwd: '/tmp', updatedAt: 1 },
        entries: [
          {
            type: 'message',
            id: 'new-runtime-message',
            message: { role: 'assistant', content: 'New runtime' },
          },
        ],
        entriesComplete: true,
        serverId: 'server-1',
        runtimeEpoch: 'runtime-new',
        cursor: 4,
      } as unknown as AuthoritativeSessionSnapshot,
      previousProjection: previous,
      generation: 1,
      serverId: 'server-1',
      coveredCursor: 4,
      replace: true,
    });

    expect(installed.projection.order).toEqual(['new-runtime-message']);
  });

  it('does not preserve live entries across a server identity change', () => {
    const previous = hydrateTranscript(
      [
        {
          type: 'message',
          id: 'old-server-message',
          message: { role: 'user', content: 'Old server' },
        },
      ],
      'session-1',
      { cursor: 5 },
    );
    const installed = installAuthoritativeTranscript({
      response: {
        metadata: { id: 'session-1', file: '', cwd: '/tmp', updatedAt: 1 },
        entries: [],
        entriesComplete: true,
        serverId: 'server-2',
        cursor: 4,
      } as unknown as AuthoritativeSessionSnapshot,
      previousProjection: previous,
      generation: 1,
      serverId: 'server-1',
      coveredCursor: 4,
      replace: true,
    });

    expect(installed.projection.order).toEqual([]);
  });

  it('seeds a complete session snapshot event without prior projection', () => {
    const projection = reduceSessionTranscriptEvent(undefined, 'session-1', {
      cursor: 1,
      emittedAt: 1,
      sessionId: 'session-1',
      event: {
        type: 'session.snapshot',
        session: {
          id: 'session-1',
          entriesComplete: true,
          entries: [
            {
              type: 'message',
              id: 'seeded',
              message: { role: 'user', content: 'hello' },
            },
          ],
        },
      },
    } as DashboardEventEnvelope);

    expect(projection?.order).toEqual(['seeded']);
  });

  it('retires persisted live overlays one-for-one', () => {
    const retained = hydrateTranscript(
      [
        {
          type: 'message',
          id: 'persisted-older',
          message: { role: 'assistant', content: 'older', timestamp: 100 },
        },
        {
          type: 'message',
          id: 'live-a',
          message: {
            role: 'user',
            content: [{ text: 'repeat', type: 'text' }],
            timestamp: '123',
          },
        },
        {
          type: 'message',
          id: 'live-b',
          message: {
            role: 'user',
            content: [{ text: 'repeat', type: 'text' }],
            timestamp: '123',
          },
        },
        {
          type: 'message',
          id: 'persisted-existing',
          message: { role: 'user', content: 'existing', timestamp: 124 },
        },
        {
          type: 'message',
          id: 'live-c',
          message: { role: 'user', content: 'existing', timestamp: 124 },
        },
      ],
      'session-1',
    );
    const latest = hydrateTranscript(
      [
        {
          type: 'message',
          id: 'persisted-older',
          message: { role: 'assistant', content: 'older', timestamp: 100 },
        },
        {
          type: 'message',
          id: 'persisted-user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'repeat' }],
            timestamp: 123,
          },
        },
        {
          type: 'message',
          id: 'persisted-existing',
          message: { role: 'user', content: 'existing', timestamp: 124 },
        },
      ],
      'session-1',
    );

    const merged = mergeLatestTranscript(
      retained,
      latest,
      {
        generation: 1,
        version: 1,
        coveredStart: 0,
        coveredEnd: 2,
        hasOlder: false,
        pages: [
          {
            start: 0,
            end: 2,
            hasOlder: false,
            entryIds: ['persisted-older', 'persisted-existing'],
            entryCount: 2,
            byteCount: 1,
          },
        ],
        pageCount: 1,
        entryCount: 2,
        byteCount: 1,
      },
      ['persisted-older', 'persisted-user', 'persisted-existing'],
    );

    expect(merged.order).toEqual([
      'persisted-older',
      'persisted-user',
      'persisted-existing',
      'live-b',
      'live-c',
    ]);
  });

  it('uses stable custom identities without text-only or ambiguous matches', () => {
    const cases = [
      {
        name: 'different dedupe keys',
        entries: [{ customType: 'notice', details: { dedupeKey: 'disk-1' } }],
        live: { customType: 'notice', details: { dedupeKey: 'live-1' } },
        expected: undefined,
      },
      {
        name: 'different custom types',
        entries: [{ customType: 'notice', details: { dedupeKey: 'same' } }],
        live: { customType: 'other', details: { dedupeKey: 'same' } },
        expected: undefined,
      },
      {
        name: 'missing stable key',
        entries: [{ customType: 'notice' }],
        live: { customType: 'notice' },
        expected: undefined,
      },
      {
        name: 'ambiguous durable identity',
        entries: [
          { customType: 'notice', details: { dedupeKey: 'same' } },
          { customType: 'notice', details: { dedupeKey: 'same' } },
        ],
        live: { customType: 'notice', details: { dedupeKey: 'same' } },
        expected: undefined,
      },
      {
        name: 'legacy delivery key',
        entries: [{ customType: 'notice', details: { deliveryKey: 'old-1' } }],
        live: { customType: 'notice', details: { deliveryKey: 'old-1' } },
        expected: 'entry-0',
      },
      {
        name: 'legacy id key',
        entries: [{ customType: 'notice', details: { id: 'old-2' } }],
        live: { customType: 'notice', details: { id: 'old-2' } },
        expected: 'entry-0',
      },
      {
        name: 'legacy jobs key',
        entries: [
          {
            customType: 'notice',
            details: { jobs: [{ id: 'job-b' }, { id: 'job-a' }] },
          },
        ],
        live: {
          customType: 'notice',
          details: { jobs: [{ id: 'job-a' }, { id: 'job-b' }] },
        },
        expected: 'entry-0',
      },
    ] as const;

    for (const testCase of cases) {
      const projection = hydrateTranscript(
        testCase.entries.map((entry, index) => ({
          type: 'custom_message',
          id: `entry-${index}`,
          content: 'same text',
          ...entry,
        })),
        'session-1',
      );
      expect(
        persistedMessageIdForLive(projection, {
          messageId: 'live-custom',
          role: 'custom',
          content: 'same text',
          data: testCase.live,
        }),
        testCase.name,
      ).toBe(testCase.expected);
    }
  });

  it('uses older-page order while retaining newer tool data', () => {
    const current = hydrateTranscript(
      [
        {
          type: 'message',
          id: 'newer',
          message: { role: 'user', content: 'newer', timestamp: 200 },
        },
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: 'old',
            timestamp: 100,
          },
        },
        {
          type: 'message',
          message: {
            role: 'toolResult',
            toolCallId: 'old-tool',
            toolName: 'read',
            content: 'live result',
          },
        },
      ],
      'session-1',
      { fallbackEntryIds: true, fallbackEntryOffset: 10 },
    );
    const fallbackMessageId = current.order[1];
    expect(fallbackMessageId).toBeDefined();
    const older = hydrateTranscript(
      [
        {
          type: 'message',
          id: 'persisted-old',
          message: {
            role: 'assistant',
            content: 'old',
            timestamp: 100,
          },
        },
        {
          type: 'message',
          message: {
            role: 'toolResult',
            toolCallId: 'old-tool',
            toolName: 'read',
            content: 'persisted result',
          },
        },
      ],
      'session-1',
      { fallbackEntryIds: true },
    );

    const merged = mergePrependedTranscript(current, older);
    expect(merged.order).toEqual(['persisted-old', 'old-tool', 'newer']);
    expect(merged.items[fallbackMessageId as string]).toBeUndefined();
    expect(merged.items['old-tool']).toMatchObject({ result: 'live result' });
  });
});
