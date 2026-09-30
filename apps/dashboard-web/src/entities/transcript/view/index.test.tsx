import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { TranscriptModelItem } from '../../../transcript';
import { workLogTranscriptScopeKey } from '../virtual-rows';

vi.mock('../../../shared/lib/transcript-display', () => ({
  useTranscriptPreviewPreference: () => ({ start: 3, end: 3 }),
}));
vi.mock('../entries', () => ({ TranscriptEntry: () => null }));
vi.mock('../outline', () => ({ TranscriptOutline: () => null }));
vi.mock('../tool-stream', () => ({ TranscriptToolStream: () => null }));
vi.mock('../work-log', () => ({
  TranscriptWorkLog: ({
    expanded,
    loading,
    onToggle,
  }: {
    expanded: boolean;
    loading: boolean;
    onToggle: () => void;
  }) => (
    <button
      type="button"
      aria-expanded={expanded}
      aria-busy={loading || undefined}
      onClick={onToggle}
    >
      Work log
    </button>
  ),
}));
vi.mock('./live-events', () => ({
  LiveCompactionEvent: () => null,
  LivePauseEvent: () => null,
}));

import { Transcript } from './index';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const topology = (activeLeafId: string, currentPath: string) => ({
  activeLeafId,
  points: [
    {
      id: 'fork',
      paths: [
        {
          id: 'path-one',
          messageId: 'path-one',
          label: 'One',
          current: currentPath === 'path-one',
        },
        {
          id: 'path-two',
          messageId: 'path-two',
          label: 'Two',
          current: currentPath === 'path-two',
        },
      ],
    },
  ],
});

function transcriptItems(finalClosure = true): TranscriptModelItem[] {
  return [
    {
      key: 'request',
      role: 'user',
      entry: { kind: 'other' },
      raw: {},
    },
    {
      key: 'work',
      role: 'assistant',
      entry: { kind: 'other' },
      raw: {},
    },
    {
      key: 'answer',
      role: 'assistant',
      entry: { kind: 'other' },
      raw: {},
      ...(finalClosure
        ? {
            workLogClosure: {
              requestMessageId: 'request',
              finalMessageId: 'answer',
              startedAt: 1,
              endedAt: 2,
            },
          }
        : {}),
    },
  ];
}

function partialTranscriptItems(): TranscriptModelItem[] {
  return [
    {
      key: 'work',
      role: 'assistant',
      entry: { kind: 'other' },
      raw: {},
    },
    {
      key: 'answer',
      role: 'assistant',
      entry: { kind: 'other' },
      raw: {},
      workLogClosure: {
        requestMessageId: 'older-request',
        finalMessageId: 'answer',
        startedAt: 1,
        endedAt: 2,
      },
    },
  ];
}

function workLogButton(tree: ReactTestRenderer) {
  return tree.root.findByType('button');
}

describe('transcript work-log state', () => {
  it('preserves a manual expansion across a same-path leaf append', () => {
    const items = transcriptItems();
    const firstTopology = topology('leaf-one', 'path-one');
    const scope = workLogTranscriptScopeKey('session', firstTopology);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <Transcript
          modelItems={items}
          branchTopology={firstTopology}
          workLogScopeKey={scope}
        />,
      );
    });
    act(() => workLogButton(tree).props.onClick());
    expect(workLogButton(tree).props['aria-expanded']).toBe(true);

    act(() =>
      tree.update(
        <Transcript
          modelItems={[
            ...items,
            {
              key: 'later-leaf-entry',
              role: 'assistant',
              entry: { kind: 'other' },
              raw: {},
            },
          ]}
          branchTopology={topology('leaf-two', 'path-one')}
          workLogScopeKey={workLogTranscriptScopeKey(
            'session',
            topology('leaf-two', 'path-one'),
          )}
        />,
      ),
    );
    expect(workLogButton(tree).props['aria-expanded']).toBe(true);
    act(() => tree.unmount());
  });

  it('cancels a deferred open when the selected branch path changes', async () => {
    let resolveLoad!: (loaded: boolean) => void;
    const load = new Promise<boolean>((resolve) => {
      resolveLoad = resolve;
    });
    const firstTopology = topology('leaf-one', 'path-one');
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <Transcript
          modelItems={partialTranscriptItems()}
          outline={[
            {
              id: 'older-request',
              ordinal: 1,
              kind: 'user',
              label: 'Old request',
            },
          ]}
          historyStart={8}
          branchTopology={firstTopology}
          workLogScopeKey={workLogTranscriptScopeKey('session', firstTopology)}
          onExpandWorkLog={() => load}
        />,
      );
    });
    act(() => workLogButton(tree).props.onClick());
    expect(workLogButton(tree).props['aria-busy']).toBe(true);

    const alternateTopology = topology('alternate-leaf', 'path-two');
    act(() =>
      tree.update(
        <Transcript
          modelItems={partialTranscriptItems()}
          outline={[
            {
              id: 'older-request',
              ordinal: 1,
              kind: 'user',
              label: 'Old request',
            },
          ]}
          historyStart={8}
          branchTopology={alternateTopology}
          workLogScopeKey={workLogTranscriptScopeKey(
            'session',
            alternateTopology,
          )}
          onExpandWorkLog={() => load}
        />,
      ),
    );
    await act(async () => resolveLoad(true));
    expect(workLogButton(tree).props['aria-expanded']).toBe(false);
    act(() => tree.unmount());
  });
});
