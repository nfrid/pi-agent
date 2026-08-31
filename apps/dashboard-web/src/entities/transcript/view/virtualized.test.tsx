import type { RefObject } from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptModelItem } from '../../../transcript';

const virtualizer = vi.hoisted(() => {
  let count = 0;
  return {
    measure: vi.fn(),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
    setCount(nextCount: number) {
      count = nextCount;
    },
    getTotalSize: () => count * 96,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: `row-${index}`,
        start: index * 96,
      })),
  };
});

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    virtualizer.setCount(count);
    return virtualizer;
  },
}));
vi.mock('../entries', () => ({ TranscriptEntry: () => null }));
vi.mock('../outline', () => ({ TranscriptOutline: () => null }));
vi.mock('../tool-stream', () => ({ TranscriptToolStream: () => null }));
vi.mock('../virtual-scroll', () => ({
  useVirtualTranscriptScrollRestoration: () => vi.fn(),
}));
vi.mock('./live-events', () => ({
  LiveCompactionEvent: () => null,
  LivePauseEvent: () => null,
}));

import { VirtualizedTranscript } from './virtualized';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

function item(index: number): TranscriptModelItem {
  return {
    key: `message-${index}`,
    raw: {},
    entry: { kind: 'other' },
    role: 'user',
    text: `Message ${index}`,
  };
}

function transcript(items: readonly TranscriptModelItem[]) {
  return (
    <VirtualizedTranscript
      items={items}
      open={new Set()}
      setOpen={vi.fn()}
      scrollElementRef={{ current: {} } as RefObject<HTMLDivElement>}
      previewStartCount={2}
      previewEndCount={3}
    />
  );
}

describe('virtualized transcript measurement', () => {
  beforeEach(() => {
    virtualizer.measure.mockClear();
    virtualizer.measureElement.mockClear();
    virtualizer.scrollToIndex.mockClear();
  });

  it('preserves cached row measurements when a message is appended', () => {
    const items = Array.from({ length: 81 }, (_, index) => item(index));
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(transcript(items));
    });
    expect(virtualizer.measure).toHaveBeenCalledTimes(1);
    virtualizer.measure.mockClear();

    act(() => {
      tree.update(transcript([...items, item(items.length)]));
    });

    expect(virtualizer.measure).not.toHaveBeenCalled();
  });
});
