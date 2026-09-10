import type {
  DashboardHttpClient,
  DashboardLiveStore,
} from '@pi-dashboard/client';
import type { CheckoutSummary, RuntimeSnapshot } from '@pi-dashboard/protocol';
import { type ComponentType, useEffect, useRef, useState } from 'react';
import { ThreadLocationIndicator } from './composer/draft-pickers';
import {
  DelegateHistorySurface,
  ExtensionSurfaceStack,
} from './extension-surfaces';

const PIN_KEY = 'pi-dashboard-activity-panel-pinned-v1';
const ActivityExtensionSurfaceStack = ExtensionSurfaceStack as ComponentType<{
  runtime: RuntimeSnapshot | undefined;
  placement?: 'main' | 'composer';
  slotsOnly?: boolean;
  activityPanel?: boolean;
}>;
const ActivityDelegateHistorySurface = DelegateHistorySurface as ComponentType<{
  id: string;
  runtime: RuntimeSnapshot | undefined;
  sessionChange: number;
  store: DashboardLiveStore;
  client: DashboardHttpClient;
  slotsOnly?: boolean;
  activityPanel?: boolean;
}>;

function readPinned() {
  if (typeof window === 'undefined') return true;
  try {
    const saved = window.localStorage.getItem(PIN_KEY);
    if (saved !== null) return saved === 'true';
  } catch {
    // Storage is optional; desktop sessions remain pinned by default.
  }
  return window.matchMedia('(min-width: 821px)').matches;
}

export function ActivityPanel({
  runtime,
  sessionChange,
  store,
  client,
  sessionId,
  checkout,
}: {
  runtime: RuntimeSnapshot | undefined;
  sessionChange: number;
  store: DashboardLiveStore;
  client: DashboardHttpClient;
  sessionId: string;
  checkout?: CheckoutSummary;
}) {
  const [pinned, setPinned] = useState(readPinned);
  const [isDesktop, setIsDesktop] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(min-width: 821px)').matches,
  );
  const [open, setOpen] = useState(() => isDesktop);
  const panelRef = useRef<HTMLElement>(null);
  const touchStart = useRef<{ x: number; y: number } | undefined>(undefined);

  useEffect(() => {
    try {
      window.localStorage.setItem(PIN_KEY, String(pinned));
    } catch {
      // Storage is optional.
    }
  }, [pinned]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 821px)');
    const update = () => setIsDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    setOpen(isDesktop && pinned);
  }, [isDesktop, pinned]);

  useEffect(() => {
    if ((isDesktop && pinned) || !open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panelRef.current?.contains(event.target)
      )
        setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', onEscape);
    };
  }, [isDesktop, open, pinned]);

  useEffect(() => {
    const start = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (touch && touch.clientX >= window.innerWidth - 28)
        touchStart.current = { x: touch.clientX, y: touch.clientY };
    };
    const end = (event: TouchEvent) => {
      const startPoint = touchStart.current;
      const touch = event.changedTouches[0];
      touchStart.current = undefined;
      if (!startPoint || !touch || (isDesktop && pinned)) return;
      const dx = startPoint.x - touch.clientX;
      const dy = Math.abs(startPoint.y - touch.clientY);
      if (dx > 52 && dx > dy * 1.25) setOpen(true);
    };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchend', end, { passive: true });
    return () => {
      window.removeEventListener('touchstart', start);
      window.removeEventListener('touchend', end);
    };
  }, [isDesktop, pinned]);

  const panelPinned = isDesktop && pinned;
  const panelVisible = panelPinned || open;
  return (
    <>
      <button
        type="button"
        className="activity-panel-trigger"
        aria-label="Open session activity"
        aria-expanded={panelVisible}
        onClick={() => setOpen(true)}
      >
        <span data-category="tasks">Tasks</span>
        <span data-category="delegates">Delegates</span>
      </button>
      <aside
        ref={panelRef}
        className={`activity-panel${panelVisible ? ' is-open' : ''}${panelPinned ? ' is-pinned' : ' is-overlay'}`}
        aria-label="Session activity"
      >
        <div className="activity-panel-bar">
          <strong>Activity</strong>
          <div className="activity-panel-actions">
            <button
              type="button"
              className="activity-panel-pin"
              aria-label={
                pinned ? 'Unpin activity panel' : 'Pin activity panel'
              }
              aria-pressed={pinned}
              onClick={() => setPinned((value) => !value)}
            >
              {pinned ? '⌖' : '◇'}
            </button>
            {!pinned && (
              <button
                type="button"
                className="activity-panel-close"
                aria-label="Close activity panel"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            )}
          </div>
        </div>
        <nav
          className="activity-panel-categories"
          aria-label="Activity categories"
        >
          <button type="button" data-category="tasks">
            Tasks
          </button>
          <button type="button" data-category="delegates">
            Delegates
          </button>
        </nav>
        <div className="activity-panel-sections">
          <section
            className="activity-panel-section"
            aria-labelledby="activity-tasks"
          >
            <h2 id="activity-tasks">Tasks</h2>
            <ActivityExtensionSurfaceStack
              runtime={runtime}
              placement="composer"
              slotsOnly
              activityPanel
            />
          </section>
          <section
            className="activity-panel-section"
            aria-labelledby="activity-delegates"
          >
            <h2 id="activity-delegates">Delegates</h2>
            <ActivityDelegateHistorySurface
              id={sessionId}
              runtime={runtime}
              sessionChange={sessionChange}
              store={store}
              client={client}
              slotsOnly
              activityPanel
            />
          </section>
          {checkout && (
            <section
              className="activity-panel-section"
              aria-labelledby="activity-location"
            >
              <h2 id="activity-location">Checkout</h2>
              <ThreadLocationIndicator checkout={checkout} />
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
