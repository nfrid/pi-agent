import { describe, expect, it } from 'vitest';
import {
  createTranscriptProjection,
  hydrateTranscript,
  persistedEntryToTranscriptEvents,
  reduceTranscriptEvent,
} from './transcript.js';

const data = {
  requestMessageId: 'entry-user',
  finalMessageId: 'entry-assistant',
  startedAt: 100,
  endedAt: 200,
  liveRequestMessageId: 'live-user',
  liveFinalMessageId: 'live-assistant',
};
const marker = {
  id: 'entry-marker',
  type: 'custom' as const,
  customType: 'response-closure' as const,
  data,
};

describe('response closure transcript marker', () => {
  it('keeps the persisted marker as a hidden raw other item', () => {
    const projection = hydrateTranscript([
      { type: 'custom', customType: marker.customType, id: marker.id, data },
    ]);
    expect(projection.items[marker.id]).toEqual({
      kind: 'other',
      id: marker.id,
      raw: {
        type: 'custom',
        customType: marker.customType,
        id: marker.id,
        data,
      },
    });
  });

  it('rejects malformed persisted intervals instead of projecting them', () => {
    const projection = hydrateTranscript([
      {
        type: 'custom',
        customType: marker.customType,
        id: marker.id,
        data: { ...data, endedAt: Number.NaN },
      },
    ]);
    expect(projection.items[marker.id]).toBeUndefined();
  });

  it('round-trips persisted history with the exact marker ID and timestamps', () => {
    const [event] = persistedEntryToTranscriptEvents(
      { type: 'custom', customType: marker.customType, id: marker.id, data },
      's',
    );
    expect(event).toMatchObject({
      type: 'session.compacted',
      entryId: marker.id,
      entry: { customType: marker.customType, data },
    });
  });

  it('projects the exact same marker from the live settled event', () => {
    const projection = reduceTranscriptEvent(createTranscriptProjection('s'), {
      type: 'agent.settled',
      sessionId: 's',
      closure: marker,
    });
    expect(projection.items[marker.id]).toEqual({
      kind: 'other',
      id: marker.id,
      raw: marker,
    });
  });
});
