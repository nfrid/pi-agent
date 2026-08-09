import { describe, expect, it } from 'vitest';
import {
  type ActivityGroup,
  groupTranscript,
  type TranscriptEntry,
} from './grouping';

const preamble = (title: string, extra = {}): TranscriptEntry => ({
  kind: 'assistant',
  speaks: false,
  title,
  titleKind: 'preamble',
  ...extra,
});
const thinking: TranscriptEntry = {
  kind: 'assistant',
  speaks: false,
  narration: 'thought',
  title: 'Thinking about the next step',
  titleKind: 'narration',
};
const speech: TranscriptEntry = { kind: 'assistant', speaks: true };
const other: TranscriptEntry = { kind: 'other' };
const transparentEvent: TranscriptEntry = {
  kind: 'other',
  continuesGroup: true,
};
const call = (name: string): TranscriptEntry => ({
  kind: 'tool',
  name,
  args: {},
});

const shape = (groups: readonly ActivityGroup[]): string[] =>
  groups.map((group) => `[${group.start}..${group.end}]`);

describe('preamble-led activity grouping', () => {
  it('leaves unannounced tools and thinking runs ungrouped', () => {
    expect(
      groupTranscript([thinking, call('read'), call('edit'), thinking]),
    ).toEqual([]);
  });

  it('keeps every tool kind and arbitrarily long run in one preamble group', () => {
    expect(
      shape(
        groupTranscript([
          preamble('Inspect and update the project'),
          ...Array.from({ length: 30 }, (_, index) =>
            call(index % 2 === 0 ? 'read' : 'edit'),
          ),
        ]),
      ),
    ).toEqual(['[0..30]']);
  });

  it('does not open or split on thinking narration', () => {
    expect(
      shape(
        groupTranscript([
          thinking,
          call('read'),
          preamble('First announced task'),
          thinking,
          call('edit'),
          thinking,
          call('bash'),
        ]),
      ),
    ).toEqual(['[2..6]']);
  });

  it('starts the next group only at a later explicit preamble', () => {
    expect(
      shape(
        groupTranscript([
          preamble('Inspect files'),
          call('read'),
          call('grep'),
          preamble('Edit the fix'),
          call('edit'),
        ]),
      ),
    ).toEqual(['[0..2]', '[3..4]']);
  });

  it('keeps transparent semantic events before, between, and after tools', () => {
    expect(
      shape(
        groupTranscript([
          preamble('Track the work'),
          transparentEvent,
          call('read'),
          transparentEvent,
          call('edit'),
          transparentEvent,
        ]),
      ),
    ).toEqual(['[0..5]']);
  });

  it('leaves plain speech and ordinary other entries outside groups and ends the active group', () => {
    expect(
      shape(
        groupTranscript([
          preamble('First task'),
          call('read'),
          speech,
          call('edit'),
          other,
          call('write'),
          preamble('Second task'),
          call('bash'),
        ]),
      ),
    ).toEqual(['[0..1]', '[6..7]']);
  });

  it('does not let a transparent event open a group by itself', () => {
    expect(groupTranscript([transparentEvent, call('read')])).toEqual([]);
  });

  it('honours closesGroup without allowing a following tool to rejoin', () => {
    expect(
      shape(
        groupTranscript([
          preamble('A bounded task'),
          { ...call('read'), closesGroup: true },
          call('edit'),
          preamble('A later task'),
          call('write'),
        ]),
      ),
    ).toEqual(['[0..1]', '[3..4]']);
  });

  it('keeps a streaming preamble groupable before tools arrive', () => {
    expect(
      groupTranscript([preamble('Preparing the change', { streaming: true })]),
    ).toEqual([{ start: 0, end: 0 }]);
  });

  it('does not treat an empty preamble title as an announcement', () => {
    expect(
      groupTranscript([
        preamble('   '),
        call('read'),
        preamble('Named task'),
        call('edit'),
      ]),
    ).toEqual([{ start: 2, end: 3 }]);
  });
});
