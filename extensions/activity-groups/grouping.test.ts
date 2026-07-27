import { describe, expect, it } from 'vitest';
import {
  type ActivityGroup,
  groupTranscript,
  MAX_GROUP_CALLS,
  type TranscriptEntry,
} from './grouping';

const thinks: TranscriptEntry = { kind: 'assistant', speaks: false };
const says: TranscriptEntry = { kind: 'assistant', speaks: true };
const user: TranscriptEntry = { kind: 'other' };
const call = (name: string, args: unknown = {}): TranscriptEntry => ({
  kind: 'tool',
  name,
  args,
});

/** "[0..3]" per group. */
const shape = (groups: readonly ActivityGroup[]): string[] =>
  groups.map((group) => `[${group.start}..${group.end}]`);

describe('grouping a transcript', () => {
  it('gathers a turn and its calls, and leaves everything else alone', () => {
    expect(
      shape(groupTranscript([user, thinks, call('read'), call('grep')])),
    ).toEqual(['[1..3]']);
  });

  it('ends the phase before anything the model says', () => {
    // The answer stands outside the work it reports on, and Pi prints it as it
    // always has; the group above it is finished the moment it is spoken.
    expect(
      shape(groupTranscript([thinks, call('read'), says, thinks])),
    ).toEqual(['[0..1]', '[3..3]']);
  });

  it('makes commentary the leader of the work it introduces', () => {
    // "Now I'll check how sessions expire", and then it goes and does that:
    // the line names the group below rather than footnoting the one above.
    expect(
      shape(groupTranscript([thinks, call('read'), says, call('read')])),
    ).toEqual(['[0..1]', '[2..3]']);
  });

  it('splits when the work turns from looking around to changing things', () => {
    expect(
      shape(
        groupTranscript([
          thinks,
          call('read'),
          call('grep'),
          thinks,
          call('edit'),
          thinks,
          call('bash', { command: 'npm test' }),
        ]),
      ),
    ).toEqual(['[0..2]', '[3..6]']);
  });

  it('ends a build once it goes back to looking around', () => {
    expect(
      shape(
        groupTranscript([
          thinks,
          call('edit'),
          thinks,
          call('read'),
          call('read'),
          call('read'),
          call('read'),
          call('read'),
        ]),
      ),
    ).toEqual(['[0..1]', '[2..7]']);
  });

  it('cuts where the model says it moved on, once a group has real work', () => {
    const narrates = (header: string): TranscriptEntry => ({
      kind: 'assistant',
      speaks: false,
      header,
    });
    const reads = (n: number) => Array.from({ length: n }, () => call('read'));

    // Announcing something new after a stretch of work ends that stretch …
    expect(
      shape(
        groupTranscript([
          narrates('Reading the auth code'),
          ...reads(6),
          narrates('Checking how sessions expire'),
          ...reads(3),
        ]),
      ),
    ).toEqual(['[0..6]', '[7..10]']);

    // … but a group with barely anything in it keeps going: models announce
    // far more often than they actually change what they are doing.
    expect(
      shape(
        groupTranscript([
          narrates('Reading the auth code'),
          ...reads(2),
          narrates('Still reading the auth code'),
          ...reads(3),
        ]),
      ),
    ).toEqual(['[0..6]']);
  });

  it('cuts a run that never changes character into readable chunks', () => {
    const entries = [thinks, ...Array.from({ length: 30 }, () => call('read'))];
    const groups = groupTranscript(entries);
    expect(groups.length).toBe(Math.ceil(30 / MAX_GROUP_CALLS));
  });

  it('breaks on anything it does not understand', () => {
    expect(
      shape(
        groupTranscript([thinks, call('read'), user, thinks, call('read')]),
      ),
    ).toEqual(['[0..1]', '[3..4]']);
  });

  it('honours a boundary only the caller could know about', () => {
    // The live session reports where a run stopped, so the group the user
    // watched finish cannot start growing again when the next one begins.
    const entries: TranscriptEntry[] = [
      thinks,
      { ...call('read'), closesGroup: true },
      thinks,
      call('read'),
    ];
    expect(shape(groupTranscript(entries))).toEqual(['[0..1]', '[2..3]']);
  });

  /**
   * The property the whole design rests on: every boundary is decided from the
   * entries before it. So a transcript groups the same way whether it arrives
   * one entry at a time or is read back from disk in one go, and watching it
   * grow never rearranges what is already on screen.
   */
  it('never rearranges what came before when more arrives', () => {
    const transcript: TranscriptEntry[] = [
      user,
      thinks,
      call('read'),
      call('grep'),
      thinks,
      call('edit'),
      call('edit'),
      thinks,
      call('bash', { command: 'npm test' }),
      says,
      thinks,
      ...Array.from({ length: 20 }, () => call('read')),
      says,
    ];

    const whole = groupTranscript(transcript);
    for (let length = 1; length <= transcript.length; length += 1) {
      const prefix = groupTranscript(transcript.slice(0, length));
      // Every group but the one still open must already be final.
      const settled = prefix.slice(0, -1);
      expect(shape(whole).slice(0, settled.length)).toEqual(shape(settled));
    }
  });
});
