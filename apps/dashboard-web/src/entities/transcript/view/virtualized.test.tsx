import type { ComponentProps, RefObject } from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptModelItem } from '../../../transcript';
import type { TranscriptScrollCommand } from '../scroll-command';

const virtualizer = vi.hoisted(() => {
  let count = 0;
  return {
    measure: vi.fn(),
    measureElement: vi.fn(),
    getOffsetForIndex: vi.fn((index: number) => [index * 96, 'start']),
    scrollToIndex: vi.fn(),
    shouldAdjustScrollPositionOnItemSizeChange: undefined as
      | undefined
      | (() => boolean),
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

function transcript(
  items: readonly TranscriptModelItem[],
  scrollCommand?: TranscriptScrollCommand,
  overrides: Partial<ComponentProps<typeof VirtualizedTranscript>> = {},
) {
  return (
    <VirtualizedTranscript
      items={items}
      scrollCommand={scrollCommand}
      open={new Set()}
      setOpen={vi.fn()}
      openToolDetails={new Set()}
      setOpenToolDetails={vi.fn()}
      scrollElementRef={
        {
          current: { scrollTop: 0, querySelectorAll: () => [] },
        } as unknown as RefObject<HTMLDivElement>
      }
      previewStartCount={2}
      previewEndCount={3}
      {...overrides}
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
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
  });

  it('aligns a mounted jump target before acknowledging the estimated-row jump', () => {
    const items = Array.from({ length: 81 }, (_, index) => item(index));
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        const id = ++nextFrame;
        frames.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
    });
    const target = {
      dataset: { transcriptKey: 'message-40' },
      getBoundingClientRect: () => ({ top: 230 }),
    };
    const element = {
      scrollTop: 0,
      querySelectorAll: () => [target],
      getBoundingClientRect: () => ({ top: 80 }),
    };
    const handled = vi.fn();
    let tree!: ReturnType<typeof create>;
    try {
      act(() => {
        tree = create(
          transcript(items, undefined, {
            pendingJumpKey: 'message-40',
            onPendingJumpHandled: handled,
            scrollElementRef: {
              current: element,
            } as unknown as RefObject<HTMLDivElement>,
          }),
        );
      });
      expect(handled).not.toHaveBeenCalled();
      expect(element.scrollTop).toBe(40 * 96);
      const frame = frames.values().next().value;
      expect(frame).toBeDefined();
      act(() => frame?.(0));
      expect(element.scrollTop).toBe(40 * 96 + 150);
      expect(handled).toHaveBeenCalledTimes(1);
    } finally {
      act(() => tree?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it('owns anchor adjustments without starting virtualizer reconciliation and cancels queued writes', () => {
    const items = Array.from({ length: 81 }, (_, index) => item(index));
    const frames = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    let nextFrame = 0;
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        const id = ++nextFrame;
        frames.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id: number) => {
        cancelled.push(id);
        frames.delete(id);
      },
    });
    let tree!: ReturnType<typeof create>;
    try {
      act(() => {
        tree = create(
          transcript(items, {
            kind: 'anchor',
            signal: new AbortController().signal,
            complete: vi.fn(),
            rowKey: 'message-0',
            rowOffset: 0,
            scrollTop: 10,
          }),
        );
      });
      expect(frames.size).toBe(1);
      expect(virtualizer.shouldAdjustScrollPositionOnItemSizeChange?.()).toBe(
        false,
      );
      const first = frames.get(1);
      frames.delete(1);
      act(() => first?.(0));
      expect(virtualizer.getOffsetForIndex).toHaveBeenCalledWith(0, 'start');
      expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
      act(() => {
        tree.update(transcript(items));
      });
      expect(
        virtualizer.shouldAdjustScrollPositionOnItemSizeChange,
      ).toBeUndefined();
      expect(cancelled).toEqual([2]);
      expect(frames.size).toBe(0);
    } finally {
      act(() => tree?.unmount());
      vi.unstubAllGlobals();
    }
  });
});
