import { useLayoutEffect, useRef } from 'react';
import type { TranscriptScrollCommand } from './scroll-command';

/** Renderers execute a bounded measurement pass, never decide follow policy. */
export function useTranscriptScrollCommand(
  command: TranscriptScrollCommand | undefined,
  place: (command: TranscriptScrollCommand) => boolean,
) {
  const completedRef = useRef<TranscriptScrollCommand | undefined>(undefined);
  const placeRef = useRef(place);
  useLayoutEffect(() => {
    placeRef.current = place;
  }, [place]);
  useLayoutEffect(() => {
    if (!command || command.signal.aborted || completedRef.current === command)
      return;
    let frame: number | undefined;
    let active = true;
    let attempts = 0;
    let settled = 0;
    const cancel = () => {
      active = false;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
    const step = () => {
      if (!active || command.signal.aborted) return;
      settled = placeRef.current(command) ? settled + 1 : 0;
      attempts += 1;
      if (settled >= 3 || attempts >= 12) {
        completedRef.current = command;
        command.complete();
      } else frame = window.requestAnimationFrame(step);
    };
    command.signal.addEventListener('abort', cancel, { once: true });
    frame = window.requestAnimationFrame(step);
    return () => {
      cancel();
      command.signal.removeEventListener('abort', cancel);
    };
  }, [command]);
}

export function restoreRenderedAnchor(
  element: HTMLDivElement,
  command: TranscriptScrollCommand,
): boolean | undefined {
  const row = command.rowKey
    ? Array.from(
        element.querySelectorAll<HTMLElement>(
          '[data-transcript-key], [data-transcript-row]',
        ),
      ).find(
        (candidate) =>
          (candidate.dataset.transcriptKey ??
            candidate.dataset.transcriptRow) === command.rowKey,
      )
    : undefined;
  if (!row || command.rowOffset === undefined) return undefined;
  const adjustment =
    row.getBoundingClientRect().top -
    element.getBoundingClientRect().top -
    command.rowOffset;
  element.scrollTop += adjustment;
  return Math.abs(adjustment) < 1;
}
