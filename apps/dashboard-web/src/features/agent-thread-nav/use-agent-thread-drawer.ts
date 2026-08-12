import { type TouchEvent, useEffect, useRef, useState } from 'react';
import { useOverlayPresence } from '../overlay-presence';

export type AgentThreadNavMode = 'home' | 'session';

type AgentThreadDrawerOptions = {
  mode: AgentThreadNavMode;
  open: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function useAgentThreadDrawer({
  mode,
  open,
  onOpenChange,
}: AgentThreadDrawerOptions) {
  const touchStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const edgeTouchStart = useRef<{ x: number; y: number } | undefined>(
    undefined,
  );
  const drawerRef = useRef<HTMLElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 820px)').matches,
  );
  const { present: drawerPresent, exiting: drawerExiting } = useOverlayPresence(
    mode === 'session' && open,
  );

  useEffect(() => {
    if (mode !== 'session') return;
    const media = window.matchMedia('(max-width: 820px)');
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [mode]);

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    if (touch) touchStart.current = { x: touch.clientX, y: touch.clientY };
  };

  const onTouchEnd = (event: TouchEvent) => {
    const start = touchStart.current;
    const touch = event.changedTouches[0];
    touchStart.current = undefined;
    if (!start || !touch || mode !== 'session') return;
    const dx = touch.clientX - start.x;
    const dy = Math.abs(touch.clientY - start.y);
    if (start.x < 32 && dx > 52 && dx > dy * 1.25) onOpenChange?.(true);
    if (open && dx < -52 && Math.abs(dx) > dy * 1.25) onOpenChange?.(false);
  };

  useEffect(() => {
    if (mode !== 'session') return;
    const onStart = (event: globalThis.TouchEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-swipe-dismiss="right"]')
      )
        return;
      const touch = event.changedTouches[0];
      if (touch && touch.clientX < 32) {
        event.preventDefault();
        edgeTouchStart.current = { x: touch.clientX, y: touch.clientY };
      }
    };
    const onEnd = (event: globalThis.TouchEvent) => {
      const start = edgeTouchStart.current;
      const touch = event.changedTouches[0];
      edgeTouchStart.current = undefined;
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = Math.abs(touch.clientY - start.y);
      if (dx > 52 && dx > dy * 1.25) onOpenChange?.(true);
      else if (open && dx < -52 && Math.abs(dx) > dy * 1.25)
        onOpenChange?.(false);
    };
    window.addEventListener('touchstart', onStart, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchend', onEnd);
    };
  }, [mode, onOpenChange, open]);

  useEffect(() => {
    if (mode !== 'session' || !open) return;
    const mobile = window.matchMedia('(max-width: 820px)').matches;
    const frame = mobile
      ? window.requestAnimationFrame(() => {
          const first = drawerRef.current?.querySelector<HTMLElement>(
            'input, button:not(:disabled), [href]',
          );
          first?.focus();
        })
      : undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChange?.(false);
        return;
      }
      if (!mobile || event.key !== 'Tab' || !drawerRef.current) return;
      const focusable = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(
          'input, button:not(:disabled), [href]',
        ),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
      if (mobile && !document.querySelector('.interaction-dock'))
        handleRef.current?.focus({ preventScroll: true });
    };
  }, [mode, onOpenChange, open]);

  return {
    drawerRef,
    handleRef,
    drawerPresent,
    drawerExiting,
    isMobile,
    onTouchStart,
    onTouchEnd,
  };
}
