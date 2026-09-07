import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { TranscriptScrollCommand } from './scroll-command';
import {
  restoreRenderedAnchor,
  useTranscriptScrollCommand,
} from './use-scroll-command';

it('does not call a moving measured anchor settled', () => {
  const element = {
    scrollTop: 100,
    getBoundingClientRect: () => ({ top: 10 }),
    querySelectorAll: () => [
      {
        dataset: { transcriptKey: 'saved-row' },
        getBoundingClientRect: () => ({ top: 150 - element.scrollTop }),
      },
    ],
  } as unknown as HTMLDivElement;
  const command: TranscriptScrollCommand = {
    kind: 'anchor',
    rowKey: 'saved-row',
    rowOffset: 5,
    scrollTop: 100,
    signal: new AbortController().signal,
    complete: vi.fn(),
  };
  expect(restoreRenderedAnchor(element, command)).toBe(false);
  expect(element.scrollTop).toBe(135);
  expect(restoreRenderedAnchor(element, command)).toBe(true);
});

it.each([
  false,
  true,
])('keeps measurement work bounded across live renders (abort=%s)', async (cancel) => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const abort = new AbortController();
  const complete = vi.fn();
  const place = vi.fn(() => true);
  const command: TranscriptScrollCommand = {
    kind: 'anchor',
    scrollTop: 420,
    signal: abort.signal,
    complete,
  };
  function Probe({ revision }: { revision: number }) {
    useTranscriptScrollCommand(command, () => {
      void revision;
      return place();
    });
    return null;
  }
  const flush = async () => {
    const [id, callback] = [...frames][0];
    frames.delete(id);
    await act(async () => callback(0));
  };
  let tree: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      tree = create(createElement(Probe, { revision: 0 }));
    });
    await flush();
    expect(place).toHaveBeenCalledOnce();
    const queued = [...frames.values()][0];
    await act(async () => {
      tree?.update(createElement(Probe, { revision: 1 }));
    });
    if (cancel) {
      abort.abort();
      expect(frames.size).toBe(0);
      await act(async () => queued?.(0));
      expect(place).toHaveBeenCalledOnce();
      expect(complete).not.toHaveBeenCalled();
    } else {
      await flush();
      await act(async () => {
        tree?.update(createElement(Probe, { revision: 2 }));
      });
      await flush();
      expect(complete).toHaveBeenCalledOnce();
      expect(frames.size).toBe(0);
    }
  } finally {
    await act(async () => tree?.unmount());
    vi.unstubAllGlobals();
  }
});
