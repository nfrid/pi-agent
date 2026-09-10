import type {
  DashboardHttpClient,
  DashboardLiveStore,
} from '@pi-dashboard/client';
import {
  DELEGATE_RENDERER_ID,
  type DelegateStatusViewModel,
  DelegateStatusViewModelSchema,
  TASKS_RENDERER_ID,
  type TaskStateViewModel,
  TaskStateViewModelSchema,
} from '@pi-dashboard/extension-contributions';
import type { CheckoutSummary, RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useEffect, useRef, useState } from 'react';
import { Value } from 'typebox/value';
import { ThreadLocationIndicator } from './composer/draft-pickers';
import {
  DelegateHistorySurface,
  ExtensionSurfaceStack,
  runtimeExtensionSurfaces,
} from './extension-surfaces';
import { useModifierShortcut } from './modifier-shortcuts';
import { SidePanelSurface } from './surface-stack';

const PIN_KEY = 'pi-dashboard-activity-panel-pinned-v1';
const WIDE_QUERY = '(min-width: 1200px)';

export type ActivityHints = {
  tasks: boolean;
  delegates: boolean;
};

function mediaMatches(query: string) {
  return typeof window !== 'undefined' && window.matchMedia(query).matches;
}

function readPinnedPreference() {
  if (typeof window === 'undefined') return true;
  try {
    const saved = window.localStorage.getItem(PIN_KEY);
    if (saved !== null) return saved === 'true';
  } catch {
    // Storage is optional.
  }
  return true;
}

function activityHints(runtime: RuntimeSnapshot | undefined): ActivityHints {
  let tasks = false;
  let delegates = false;
  for (const surface of runtimeExtensionSurfaces(runtime)) {
    if (
      !tasks &&
      surface.rendererId === TASKS_RENDERER_ID &&
      Value.Check(TaskStateViewModelSchema, surface.viewModel)
    ) {
      const model = surface.viewModel as TaskStateViewModel;
      tasks = model.tasks.some(
        (task) => task.status !== 'done' && task.status !== 'dropped',
      );
    }
    if (
      !delegates &&
      surface.rendererId === DELEGATE_RENDERER_ID &&
      Value.Check(DelegateStatusViewModelSchema, surface.viewModel)
    ) {
      const model = surface.viewModel as DelegateStatusViewModel;
      delegates = model.statuses.some(
        (status) => status.state === 'queued' || status.state === 'running',
      );
    }
    if (tasks && delegates) break;
  }
  return { tasks, delegates };
}

export function useActivityPanelState(runtime: RuntimeSnapshot | undefined) {
  const [isWide, setIsWide] = useState(() => mediaMatches(WIDE_QUERY));
  const [pinnedPreference, setPinnedPreference] =
    useState(readPinnedPreference);
  const [open, setOpen] = useState(
    () => mediaMatches(WIDE_QUERY) && readPinnedPreference(),
  );

  useEffect(() => {
    const media = window.matchMedia(WIDE_QUERY);
    const update = () => setIsWide(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    setOpen(isWide && pinnedPreference);
  }, [isWide, pinnedPreference]);

  const pinned = isWide && pinnedPreference;
  return {
    isWide,
    pinned,
    open,
    hints: activityHints(runtime),
    setOpen,
    togglePinned: () =>
      setPinnedPreference((value) => {
        const next = !value;
        try {
          window.localStorage.setItem(PIN_KEY, String(next));
        } catch {
          // Storage is optional.
        }
        return next;
      }),
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
  const panelRef = useRef<HTMLElement>(null);
  const overlay = !pinned;
  const openSection = (label: string) => {
    onOpen();
    window.requestAnimationFrame(() => {
      const section = panelRef.current?.querySelector<HTMLElement>(
        `section[aria-label="${label}"]`,
      );
      section?.focus({ preventScroll: true });
      section?.scrollIntoView({ block: 'nearest' });
    });
  };
  useModifierShortcut(
    { code: 'KeyT', alt: true },
    () => openSection('Tasks'),
    true,
  );
  useModifierShortcut({ code: 'KeyD' }, () => openSection('Delegates'), true);
  const panel = (
    <aside
      ref={panelRef}
      className={`activity-panel${open ? ' is-open' : ''}${!open ? ' is-exiting' : ''}${pinned ? ' is-pinned' : ' is-overlay'}`}
      aria-label="Session activity"
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
            <ThreadLocationIndicator checkout={checkout} compact />
          </section>
        )}
      </div>
    </aside>
  );
  if (!overlay) return panel;
  return (
    <SidePanelSurface
      open={open}
      onOpenChange={(nextOpen) => (nextOpen ? onOpen() : onClose())}
      side="right"
      ariaLabel="Session activity"
      edgeOpen={!isWide}
    >
      {panel}
    </SidePanelSurface>
  );
}
