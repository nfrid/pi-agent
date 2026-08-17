import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import navStyles from '../agent-thread-nav.module.css';
import type { RuntimeLifecycleThreadProps } from './availability';

type ActiveTouch = {
  pointerId: number;
  clientX: number;
  clientY: number;
};

type MenuPoint = {
  x: number;
  y: number;
};

type MenuPosition = {
  left: number;
  top: number;
};

const LONG_PRESS_DELAY = 500;
const LONG_PRESS_MOVE_TOLERANCE = 8;
const VIEWPORT_MARGIN = 8;

export function useRuntimeLifecycleMenu({
  enabled,
  title,
  rowRef,
  threadButtonRef,
}: {
  enabled: boolean;
  title: string;
  rowRef: RefObject<HTMLDivElement | null>;
  threadButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<number | undefined>(undefined);
  const activeTouchRef = useRef<ActiveTouch | undefined>(undefined);
  const longPressTriggeredRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<MenuPoint>();
  const [menuPosition, setMenuPosition] = useState<MenuPosition>({
    left: VIEWPORT_MARGIN,
    top: VIEWPORT_MARGIN,
  });
  const menuId = `agent-thread-actions-menu-${useId()}`;

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current !== undefined) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = undefined;
    }
    activeTouchRef.current = undefined;
    longPressTriggeredRef.current = false;
  }, []);

  const openMenu = useCallback((point: MenuPoint) => {
    setMenuAnchor(point);
    setMenuPosition({ left: point.x, top: point.y });
    setOpen(true);
  }, []);

  const closeMenu = useCallback(
    (restoreFocus: boolean, preserveLongPressClick = false) => {
      if (!preserveLongPressClick || !longPressTriggeredRef.current) {
        cancelLongPress();
      } else {
        if (longPressTimerRef.current !== undefined) {
          window.clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = undefined;
        }
        activeTouchRef.current = undefined;
      }
      setOpen(false);
      if (restoreFocus) threadButtonRef.current?.focus();
    },
    [cancelLongPress, threadButtonRef],
  );

  useEffect(() => {
    return () => cancelLongPress();
  }, [cancelLongPress]);

  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !menuAnchor) return;
    const menu = menuRef.current;
    if (!menu) return;

    const { width, height } = menu.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
    const left = Math.min(
      Math.max(menuAnchor.x, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, maxLeft),
    );
    const preferredTop =
      menuAnchor.y + height <= window.innerHeight - VIEWPORT_MARGIN
        ? menuAnchor.y
        : menuAnchor.y - height;
    const top = Math.min(
      Math.max(preferredTop, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, maxTop),
    );

    setMenuPosition((current) =>
      current.left === left && current.top === top ? current : { left, top },
    );
  }, [menuAnchor, open]);

  useEffect(() => {
    if (!open) return;
    const closeForViewportChange = () => closeMenu(true);
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      ) {
        closeMenu(
          true,
          threadButtonRef.current?.contains(event.target) ?? false,
        );
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMenu(true);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', closeForViewportChange);
    window.addEventListener('scroll', closeForViewportChange, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', closeForViewportChange);
      window.removeEventListener('scroll', closeForViewportChange, true);
    };
  }, [closeMenu, open, threadButtonRef]);

  const handleContextMenu = useCallback(
    (event: globalThis.MouseEvent) => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      )
        return;
      event.preventDefault();
      openMenu({ x: event.clientX, y: event.clientY });
    },
    [openMenu],
  );
  const handlePointerDown = useCallback(
    (event: globalThis.PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      cancelLongPress();
      const { pointerId, clientX, clientY } = event;
      activeTouchRef.current = { pointerId, clientX, clientY };
      const row = event.currentTarget as HTMLDivElement;
      try {
        row.setPointerCapture?.(pointerId);
      } catch {
        // Synthetic pointer events and cancelled touches may not be capturable.
      }
      longPressTimerRef.current = window.setTimeout(() => {
        if (activeTouchRef.current?.pointerId !== pointerId) return;
        longPressTimerRef.current = undefined;
        longPressTriggeredRef.current = true;
        openMenu({ x: clientX, y: clientY });
      }, LONG_PRESS_DELAY);
    },
    [cancelLongPress, openMenu],
  );
  const handlePointerMove = useCallback(
    (event: globalThis.PointerEvent) => {
      const activeTouch = activeTouchRef.current;
      if (!activeTouch || activeTouch.pointerId !== event.pointerId) return;
      if (
        Math.hypot(
          event.clientX - activeTouch.clientX,
          event.clientY - activeTouch.clientY,
        ) > LONG_PRESS_MOVE_TOLERANCE
      ) {
        cancelLongPress();
      }
    },
    [cancelLongPress],
  );
  const handlePointerUp = useCallback((event: globalThis.PointerEvent) => {
    const activeTouch = activeTouchRef.current;
    if (!activeTouch || activeTouch.pointerId !== event.pointerId) return;
    const triggered = longPressTriggeredRef.current;
    if (longPressTimerRef.current !== undefined) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = undefined;
    }
    activeTouchRef.current = undefined;
    if (!triggered) longPressTriggeredRef.current = false;
    const row = event.currentTarget as HTMLDivElement;
    if (row.hasPointerCapture(event.pointerId)) {
      row.releasePointerCapture(event.pointerId);
    }
  }, []);
  const handlePointerCancel = useCallback(
    (event: globalThis.PointerEvent) => {
      if (activeTouchRef.current?.pointerId !== event.pointerId) return;
      cancelLongPress();
    },
    [cancelLongPress],
  );
  const handleClickCapture = useCallback(
    (event: globalThis.MouseEvent) => {
      if (!longPressTriggeredRef.current) return;
      const isThreadClick =
        event.target instanceof Node &&
        (threadButtonRef.current?.contains(event.target) ?? false);
      longPressTriggeredRef.current = false;
      if (!isThreadClick) return;
      event.preventDefault();
      event.stopPropagation();
    },
    [threadButtonRef],
  );
  const handleThreadKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
  ): void => {
    const invokesMenu =
      event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
    if (invokesMenu) {
      event.preventDefault();
      event.stopPropagation();
      const button = threadButtonRef.current;
      const buttonRect = button?.getBoundingClientRect();
      openMenu({
        x: buttonRect?.left ?? VIEWPORT_MARGIN,
        y: buttonRect?.bottom ?? VIEWPORT_MARGIN,
      });
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    }
  };

  useEffect(() => {
    if (!enabled) return;
    const row = rowRef.current;
    if (!row) return;
    row.addEventListener('contextmenu', handleContextMenu);
    row.addEventListener('pointerdown', handlePointerDown);
    row.addEventListener('pointermove', handlePointerMove);
    row.addEventListener('pointerup', handlePointerUp);
    row.addEventListener('pointercancel', handlePointerCancel);
    row.addEventListener('click', handleClickCapture, true);
    return () => {
      row.removeEventListener('contextmenu', handleContextMenu);
      row.removeEventListener('pointerdown', handlePointerDown);
      row.removeEventListener('pointermove', handlePointerMove);
      row.removeEventListener('pointerup', handlePointerUp);
      row.removeEventListener('pointercancel', handlePointerCancel);
      row.removeEventListener('click', handleClickCapture, true);
    };
  }, [
    enabled,
    handleClickCapture,
    handleContextMenu,
    handlePointerCancel,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    rowRef,
  ]);

  const threadProps: RuntimeLifecycleThreadProps | undefined = enabled
    ? {
        ref: threadButtonRef,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
        onKeyDown: handleThreadKeyDown,
      }
    : undefined;

  const renderMenu = (content: React.ReactNode) =>
    open
      ? createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className={`agent-thread-actions-menu ${navStyles.lifecycleActionsMenu}`}
            role="menu"
            style={{ left: menuPosition.left, top: menuPosition.top }}
            aria-label={`Actions for ${title}`}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeMenu(true);
              }
            }}
          >
            {content}
          </div>,
          document.body,
        )
      : null;

  return {
    closeMenu,
    threadProps,
    renderMenu,
  };
}
