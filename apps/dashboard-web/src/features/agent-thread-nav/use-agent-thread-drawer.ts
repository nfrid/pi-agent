import { type TouchEvent, useEffect, useRef, useState } from 'react';
import {
  useOverlayFocusRestore,
  useOverlayFocusTrap,
  useOverlayPresence,
} from '../overlay-presence';
import { useAgentNavSwipe } from '../swipe-to-dismiss';

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
  const drawerRef = useRef<HTMLElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 820px)').matches,
  );
  const enabled = mode === 'session';
  const { present: drawerPresent, exiting: drawerExiting } = useOverlayPresence(
    enabled && open,
  );
  useOverlayFocusRestore(enabled && open, '.agent-nav-handle');
  useOverlayFocusTrap(enabled && open, drawerRef, {
    mobile: isMobile,
    restoreFocusRef: handleRef,
  });
  const { onTouchStart, onTouchEnd } = useAgentNavSwipe({
    enabled,
    open,
    onOpenChange,
  });

  useEffect(() => {
    if (!enabled) return;
    const media = window.matchMedia('(max-width: 820px)');
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChange?.(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, onOpenChange, open]);

  return {
    drawerRef,
    handleRef,
    drawerPresent,
    drawerExiting,
    isMobile,
    onTouchStart: enabled ? onTouchStart : undefined,
    onTouchEnd: enabled ? onTouchEnd : undefined,
  };
}

export type AgentThreadDrawerTouchHandler = (event: TouchEvent) => void;
