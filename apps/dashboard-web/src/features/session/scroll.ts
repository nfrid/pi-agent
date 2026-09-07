import type { TranscriptProjection } from '@pi-dashboard/domain';
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { SessionScrollController } from './scroll-controller';
import {
  readSessionScrollMemory,
  sessionScrollMemoryKey,
} from './scroll-memory';

export { readSessionScrollMemory } from './scroll-memory';

/** React/DOM bindings only; follow and restoration policy belongs to the visit. */
export function useSessionScroll({
  id,
  serverId,
  data,
  projection,
  sessionMounted,
  enabled,
  scrollElementRef,
  history,
  historyAvailable = false,
  loadThroughOrdinal,
  cancelHistoryRestore,
}: {
  id: string;
  serverId?: string;
  data: { entries: readonly unknown[] } | undefined;
  projection: TranscriptProjection | undefined;
  sessionMounted: boolean;
  enabled: boolean;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  history?: { start: number; hasOlder: boolean };
  historyAvailable?: boolean;
  loadThroughOrdinal?: (ordinal: number) => Promise<boolean>;
  cancelHistoryRestore?: () => void;
}) {
  // Even without storage (inspectors), each id/enabled transition owns a fresh
  // instance. A -> B -> A cannot revive callbacks from the first A visit.
  const controller = useMemo(
    () =>
      new SessionScrollController(
        enabled && serverId ? readSessionScrollMemory(id, serverId) : undefined,
        enabled && serverId ? sessionScrollMemoryKey(id, serverId) : undefined,
      ),
    [enabled, id, serverId],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const sessionPageRef = useRef<HTMLElement>(null);
  const controlLayerRef = useRef<HTMLDivElement>(null);

  // Invalidate at commit, before any queued frame can touch a new transcript.
  useLayoutEffect(() => {
    if (!sessionMounted) return;
    return () => controller.disconnect();
  }, [controller, sessionMounted]);
  // Inspectors use an ancestor-owned scrollport: its ref is assigned after
  // child layout effects. Bind only once the whole DOM commit is complete.
  useEffect(() => {
    const element = scrollElementRef.current;
    if (!enabled || !sessionMounted || !element) return;
    controller.connect(element);
    return () => controller.disconnect();
  }, [controller, enabled, scrollElementRef, sessionMounted]);

  useEffect(() => {
    if (!sessionMounted) return;
    controller.updateHistory(
      history,
      historyAvailable,
      loadThroughOrdinal,
      cancelHistoryRestore,
    );
  }, [
    controller,
    history,
    historyAvailable,
    loadThroughOrdinal,
    cancelHistoryRestore,
    sessionMounted,
  ]);

  useLayoutEffect(() => {
    if (enabled && sessionMounted && data && projection)
      controller.contentChanged();
  }, [controller, enabled, data, projection, sessionMounted]);

  useEffect(() => {
    const element = scrollElementRef.current;
    if (!enabled || !sessionMounted || !element) return;
    let touchY: number | undefined;
    let pointerY: number | undefined;
    const wheel = (event: WheelEvent) => {
      if (event.deltaY) controller.userIntent(event.deltaY);
    };
    const pointerDown = (event: PointerEvent) => {
      pointerY = event.clientY;
      controller.read();
    };
    const pointerMove = (event: PointerEvent) => {
      if (pointerY === undefined) return;
      if (event.clientY !== pointerY)
        controller.userIntent(event.clientY - pointerY);
      pointerY = event.clientY;
    };
    const pointerUp = () => {
      pointerY = undefined;
    };
    const touchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY;
    };
    const touchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY;
      if (next !== undefined && touchY !== undefined && next !== touchY)
        controller.userIntent(touchY - next);
      touchY = next;
    };
    const keyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, [contenteditable="true"], [role="textbox"]',
        )
      )
        return;
      if (
        ['ArrowUp', 'PageUp', 'Home'].includes(event.code) ||
        (event.code === 'Space' && event.shiftKey)
      )
        controller.userIntent(-1);
      else if (['ArrowDown', 'PageDown', 'End', 'Space'].includes(event.code))
        controller.userIntent(1);
    };
    element.addEventListener('scroll', controller.onScroll, { passive: true });
    element.addEventListener('wheel', wheel, { passive: true });
    element.addEventListener('pointerdown', pointerDown, { passive: true });
    element.addEventListener('touchstart', touchStart, { passive: true });
    element.addEventListener('touchmove', touchMove, { passive: true });
    window.addEventListener('pointermove', pointerMove, { passive: true });
    window.addEventListener('pointerup', pointerUp, { passive: true });
    window.addEventListener('keydown', keyDown);
    const save = () => controller.onScroll();
    window.addEventListener('pagehide', save);
    return () => {
      element.removeEventListener('scroll', controller.onScroll);
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('pointerdown', pointerDown);
      element.removeEventListener('touchstart', touchStart);
      element.removeEventListener('touchmove', touchMove);
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('pagehide', save);
    };
  }, [controller, enabled, scrollElementRef, sessionMounted]);

  useEffect(() => {
    if (!enabled || !sessionMounted) return;
    const page = sessionPageRef.current;
    const controls = controlLayerRef.current;
    const element = scrollElementRef.current;
    if (!page || !element) return;
    const viewport = window.visualViewport;
    const updateViewport = () => {
      const bottom = viewport
        ? viewport.offsetTop + viewport.height
        : window.innerHeight;
      page.style.setProperty(
        '--session-viewport-height',
        `${Math.ceil(Math.max(0, bottom - page.getBoundingClientRect().top))}px`,
      );
    };
    const resize = () => {
      updateViewport();
      controller.contentChanged();
    };
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(resize);
    observer?.observe(page);
    observer?.observe(element);
    if (controls) observer?.observe(controls);
    const content = element.querySelector('.transcript-virtualizer');
    if (content) observer?.observe(content);
    window.addEventListener('resize', resize);
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', updateViewport);
    resize();
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', updateViewport);
    };
  }, [controller, enabled, scrollElementRef, sessionMounted]);

  return {
    awayFromLatest: enabled && state.away,
    tailReadySessionId: !enabled || state.ready ? id : undefined,
    restoring: state.phase === 'restoring',
    scrollCommand: enabled ? state.command : undefined,
    jumpToLatest: controller.latest,
    stopFollowing: controller.read,
    sessionPageRef,
    controlLayerRef,
  };
}
