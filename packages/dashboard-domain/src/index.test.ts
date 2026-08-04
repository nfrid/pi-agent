import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  applyRuntimeEvent,
  applyTranscriptEvent,
  createRuntimeReducerState,
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
) {
  return {
    cursor,
    emittedAt: cursor,
    runtimeId: 'r',
    runtimeEpoch,
    runtimeSeq,
    sessionId: 's',
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

  it('replaces an epoch and ignores a late event from the retired epoch', () => {
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
    expect(entries[0]).toMatchObject({ message: { id: 'message-1' } });
    expect(entries[1]).toMatchObject({ tool: { toolCallId: 'call-1' } });
    expect(JSON.stringify(entries)).not.toContain('must-not-be-used');
  });
});
