import type {
  DashboardHttpClient,
  DashboardLiveStore,
} from '@pi-dashboard/client';
import {
  DELEGATE_RENDERER_ID,
  TASKS_RENDERER_ID,
} from '@pi-dashboard/extension-contributions';
import type { CheckoutSummary, RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useEffect, useRef, useState } from 'react';
import { ThreadLocationIndicator } from './composer/draft-pickers';
import {
  DelegateHistorySurface,
  ExtensionSurfaceStack,
  runtimeExtensionSurfaces,
} from './extension-surfaces';
import {
  useOverlayFocusRestore,
  useOverlayFocusTrap,
  useOverlayPresence,
} from './overlay-presence';

const PIN_KEY = 'pi-dashboard-activity-panel-pinned-v1';
const WIDE_QUERY = '(min-width: 1200px)';

export type ActivityHints = {
  tasks: boolean;
  delegates: boolean;
};

function mediaMatches(query: string) {
  return typeof window !== 'undefined' && window.matchMedia(query).matches;
}

function readPinned() {
  if (typeof window === 'undefined') return true;
  try {
    const saved = window.localStorage.getItem(PIN_KEY);
    if (saved !== null) return saved === 'true';
  } catch {
    // Storage is optional; wide sessions remain pinned by default.
  }
  return mediaMatches(WIDE_QUERY);
}

export function useActivityPanelState(runtime: RuntimeSnapshot | undefined) {
  const [isWide, setIsWide] = useState(() => mediaMatches(WIDE_QUERY));
  const [pinned, setPinned] = useState(readPinned);
  const [open, setOpen] = useState(
    () => mediaMatches(WIDE_QUERY) && readPinned(),
  );

  useEffect(() => {
    const media = window.matchMedia(WIDE_QUERY);
    const update = () => setIsWide(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    setOpen(isWide && pinned);
  }, [isWide, pinned]);

  useEffect(() => {
    if (!isWide) return;
    try {
      window.localStorage.setItem(PIN_KEY, String(pinned));
    } catch {
      // Storage is optional.
    }
  }, [isWide, pinned]);

  const surfaces = runtimeExtensionSurfaces(runtime);
  const hints: ActivityHints = {
    tasks: surfaces.some((surface) => surface.rendererId === TASKS_RENDERER_ID),
    delegates: surfaces.some(
      (surface) => surface.rendererId === DELEGATE_RENDERER_ID,
    ),
  };
  return {
    isWide,
    pinned,
    open,
    hints,
    setOpen,
    togglePinned: () => setPinned((value) => !value),
  };
}

export function ActivityPanel({
  runtime,
  sessionChange,
  store,
  client,
  sessionId,
  checkout,
  isWide,
  pinned,
  open,
  onOpen,
  onClose,
  onTogglePinned,
}: {
  runtime: RuntimeSnapshot | undefined;
  sessionChange: number;
  store: DashboardLiveStore;
  client: DashboardHttpClient;
  sessionId: string;
  checkout?: CheckoutSummary;
  isWide: boolean;
  pinned: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onTogglePinned: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { present, exiting } = useOverlayPresence(open);
  const overlay = open && !pinned;
  useOverlayFocusRestore(overlay, '.session-activity-button');
  useOverlayFocusTrap(overlay, panelRef, { mobile: !isWide });

  useEffect(() => {
    if (isWide) return;
    let start: { x: number; y: number } | undefined;
    const touchStart = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (touch && touch.clientX >= window.innerWidth - 28)
        start = { x: touch.clientX, y: touch.clientY };
    };
    const touchEnd = (event: TouchEvent) => {
      const initial = start;
      const touch = event.changedTouches[0];
      start = undefined;
      if (!initial || !touch) return;
      const dx = initial.x - touch.clientX;
      const dy = Math.abs(initial.y - touch.clientY);
      if (dx > 52 && dx > dy * 1.25) onOpen();
    };
    window.addEventListener('touchstart', touchStart, { passive: true });
    window.addEventListener('touchend', touchEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', touchStart);
      window.removeEventListener('touchend', touchEnd);
    };
  }, [isWide, onOpen]);

  useEffect(() => {
    if (!overlay) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        panelRef.current?.contains(target) ||
        target.closest('[data-surface-portal-root]')
      )
        return;
      onClose();
    };
    const onEscape = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-surface-portal-root]')
      )
        return;
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', onEscape);
    };
  }, [onClose, overlay]);

  if (!present) return null;
  return (
    <div
      ref={panelRef}
      className={`activity-panel${open ? ' is-open' : ''}${exiting ? ' is-exiting' : ''}${pinned ? ' is-pinned' : ' is-overlay'}`}
      aria-label="Session activity"
      aria-modal={overlay || undefined}
      role="dialog"
      data-activity-panel=""
    >
      <div className="activity-panel-bar">
        <strong>Activity</strong>
        <div className="activity-panel-actions">
          {isWide && (
            <button
              type="button"
              className="activity-panel-pin"
              aria-label={
                pinned ? 'Unpin activity panel' : 'Pin activity panel'
              }
              aria-pressed={pinned}
              onClick={onTogglePinned}
            >
              {pinned ? '⌖' : '◇'}
            </button>
          )}
          {overlay && (
            <button
              type="button"
              className="activity-panel-close"
              aria-label="Close activity panel"
              onClick={onClose}
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className="activity-panel-content">
        <ExtensionSurfaceStack
          runtime={runtime}
          placement="composer"
          excludeDelegate
          slotsOnly
          activityPanel
        />
        <DelegateHistorySurface
          id={sessionId}
          runtime={runtime}
          sessionChange={sessionChange}
          store={store}
          client={client}
          slotsOnly
          activityPanel
        />
        {checkout && (
          <section className="activity-panel-location">
            <h2>Checkout</h2>
            <ThreadLocationIndicator checkout={checkout} />
          </section>
        )}
      </div>
    </div>
  );
}
