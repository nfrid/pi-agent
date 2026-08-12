import { useEffect, useLayoutEffect, useRef } from 'react';

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
  threshold = 120,
): boolean {
  return scrollHeight - scrollY - innerHeight <= threshold;
}

/** Preserve the page position while a virtual transcript row changes size. */
export function useVirtualTranscriptScrollRestoration() {
  const anchorRef = useRef<{ key: string; top: number } | undefined>(undefined);
  const bottomStuckRef = useRef(false);
  const scrollIntentRevisionRef = useRef(0);
  const restoreRevisionRef = useRef(0);

  useEffect(() => {
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
    window.addEventListener('wheel', noteScrollIntent, { passive: true });
    window.addEventListener('touchmove', noteScrollIntent, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('wheel', noteScrollIntent);
      window.removeEventListener('touchmove', noteScrollIntent);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const captureScrollAnchor = (key: string) => {
    const bottomStuck = isNearPageBottom(
      document.documentElement.scrollHeight,
      window.scrollY,
      window.innerHeight,
    );
    bottomStuckRef.current = bottomStuck;
    restoreRevisionRef.current = scrollIntentRevisionRef.current;
    if (bottomStuck) {
      anchorRef.current = undefined;
      return;
    }
    const element = Array.from(
      document.querySelectorAll<HTMLElement>('[data-transcript-row]'),
    ).find((candidate) => candidate.dataset.transcriptRow === key);
    if (element)
      anchorRef.current = { key, top: element.getBoundingClientRect().top };
  };

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const bottomStuck = bottomStuckRef.current;
    const restoreRevision = restoreRevisionRef.current;
    if (!anchor && !bottomStuck) return;
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
            document.documentElement.scrollHeight,
            window.innerHeight,
            true,
          );
          if (top !== undefined) window.scrollTo(0, top);
        } else if (anchor) {
          const element = Array.from(
            document.querySelectorAll<HTMLElement>('[data-transcript-row]'),
          ).find((candidate) => candidate.dataset.transcriptRow === anchor.key);
          if (element)
            window.scrollBy({
              top: preserveVirtualScrollOffset(
                anchor.top,
                element.getBoundingClientRect().top,
                false,
              ),
              left: 0,
            });
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
