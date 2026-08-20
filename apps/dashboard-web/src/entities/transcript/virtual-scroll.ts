import type { RefObject } from 'react';
import { useEffect, useLayoutEffect, useRef } from 'react';

export const FOLLOW_REARM_DISTANCE_PX = 40;

/** Virtual scroll offset helpers for the transcript list. */
export function preserveVirtualScrollOffset(
  previousTop: number,
  nextTop: number,
  bottomStuck: boolean,
): number {
  return bottomStuck ? 0 : previousTop - nextTop;
}

export function restoreVirtualBottom(
  scrollHeight: number,
  viewportHeight: number,
  bottomStuck: boolean,
): number | undefined {
  return bottomStuck ? Math.max(0, scrollHeight - viewportHeight) : undefined;
}

export function isNearPageBottom(
  scrollHeight: number,
  scrollY: number,
  innerHeight: number,
  threshold = FOLLOW_REARM_DISTANCE_PX,
): boolean {
  return scrollHeight - scrollY - innerHeight <= threshold;
}

/** Preserve the scroll position while a virtual transcript row changes size. */
export function useVirtualTranscriptScrollRestoration(
  scrollElementRef: RefObject<HTMLDivElement | null>,
) {
  const anchorRef = useRef<{ key: string; top: number } | undefined>(undefined);
  const bottomStuckRef = useRef(false);
  const scrollIntentRevisionRef = useRef(0);
  const restoreRevisionRef = useRef(0);

  useEffect(() => {
    const scrollElement = scrollElementRef.current;
    if (!scrollElement) return;
    const noteScrollIntent = () => {
      scrollIntentRevisionRef.current += 1;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          'input, textarea, [contenteditable="true"], [role="textbox"]',
        )
      )
        return;
      if (
        [
          'ArrowUp',
          'ArrowDown',
          'PageUp',
          'PageDown',
          'Home',
          'End',
          'Space',
        ].includes(event.code)
      )
        noteScrollIntent();
    };
    scrollElement.addEventListener('wheel', noteScrollIntent, {
      passive: true,
    });
    scrollElement.addEventListener('touchmove', noteScrollIntent, {
      passive: true,
    });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      scrollElement.removeEventListener('wheel', noteScrollIntent);
      scrollElement.removeEventListener('touchmove', noteScrollIntent);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [scrollElementRef]);

  const captureScrollAnchor = (key: string) => {
    const scrollElement = scrollElementRef.current;
    if (!scrollElement) return;
    const bottomStuck = isNearPageBottom(
      scrollElement.scrollHeight,
      scrollElement.scrollTop,
      scrollElement.clientHeight,
    );
    bottomStuckRef.current = bottomStuck;
    restoreRevisionRef.current = scrollIntentRevisionRef.current;
    if (bottomStuck) {
      anchorRef.current = undefined;
      return;
    }
    const element = Array.from(
      scrollElement.querySelectorAll<HTMLElement>('[data-transcript-row]'),
    ).find((candidate) => candidate.dataset.transcriptRow === key);
    if (element)
      anchorRef.current = {
        key,
        top:
          element.getBoundingClientRect().top -
          scrollElement.getBoundingClientRect().top,
      };
  };

  useLayoutEffect(() => {
    const scrollElement = scrollElementRef.current;
    const anchor = anchorRef.current;
    const bottomStuck = bottomStuckRef.current;
    const restoreRevision = restoreRevisionRef.current;
    if (!scrollElement || (!anchor && !bottomStuck)) return;
    let measuredFrame: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      measuredFrame = window.requestAnimationFrame(() => {
        if (scrollIntentRevisionRef.current !== restoreRevision) {
          anchorRef.current = undefined;
          bottomStuckRef.current = false;
          return;
        }
        if (bottomStuck) {
          const top = restoreVirtualBottom(
            scrollElement.scrollHeight,
            scrollElement.clientHeight,
            true,
          );
          if (top !== undefined) scrollElement.scrollTop = top;
        } else if (anchor) {
          const element = Array.from(
            scrollElement.querySelectorAll<HTMLElement>(
              '[data-transcript-row]',
            ),
          ).find((candidate) => candidate.dataset.transcriptRow === anchor.key);
          if (element) {
            const nextTop =
              element.getBoundingClientRect().top -
              scrollElement.getBoundingClientRect().top;
            scrollElement.scrollTop += nextTop - anchor.top;
          }
        }
        anchorRef.current = undefined;
        bottomStuckRef.current = false;
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (measuredFrame !== undefined)
        window.cancelAnimationFrame(measuredFrame);
    };
  });

  return captureScrollAnchor;
}
