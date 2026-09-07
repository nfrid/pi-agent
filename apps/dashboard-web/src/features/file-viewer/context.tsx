import { dashboardHttpClient } from '@pi-dashboard/client';
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SurfaceStack } from '../surface-stack';
import styles from './file-viewer.module.css';
import { fileLocationKey, type ViewerEntry, type ViewerMode } from './model';
import type { FileLocation } from './reference';

const LazyFileViewer = lazy(() =>
  import('./viewer').then(({ FileViewer }) => ({ default: FileViewer })),
);

const FILE_VIEWER_HISTORY_KEY = '__piDashboardFileViewer';

type FileViewerHistoryMarker = {
  id: string;
  index: number;
  route: string;
};
type HistoryState = Record<string, unknown>;

type History = { entries: readonly ViewerEntry[]; index: number };
type ViewerSession = {
  id: string;
  route: string;
  entries: ViewerEntry[];
};

const emptyHistory: History = { entries: [], index: -1 };

function historyState(): HistoryState {
  const state = window.history.state;
  return state && typeof state === 'object' && !Array.isArray(state)
    ? state
    : {};
}

function viewerMarker(value: unknown): FileViewerHistoryMarker | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const marker = value as {
    id?: unknown;
    index?: unknown;
    route?: unknown;
  };
  return typeof marker.id === 'string' &&
    typeof marker.index === 'number' &&
    Number.isInteger(marker.index) &&
    marker.index >= 0 &&
    typeof marker.route === 'string'
    ? { id: marker.id, index: marker.index, route: marker.route }
    : undefined;
}

function currentViewerMarker(): FileViewerHistoryMarker | undefined {
  return viewerMarker(historyState()[FILE_VIEWER_HISTORY_KEY]);
}

type FileViewerContextValue = { open(location: FileLocation): void };
export const FileViewerContext = createContext<
  FileViewerContextValue | undefined
>(undefined);

export function FileViewerProvider({
  children,
  locationKey,
}: {
  children: ReactNode;
  locationKey?: string;
}) {
  const [history, setHistory] = useState<History>(emptyHistory);
  const historyRef = useRef(history);
  const sessionRef = useRef<ViewerSession | undefined>(undefined);
  const launcherRef = useRef<HTMLElement | null>(null);
  const routeRef = useRef(locationKey ?? '');
  routeRef.current = locationKey ?? '';

  const commitHistory = useCallback((next: History) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  const close = useCallback(() => {
    const current = historyRef.current;
    const session = sessionRef.current;
    const marker = currentViewerMarker();
    if (!session || current.index < 0) return;
    if (
      marker?.id !== session.id ||
      marker.route !== session.route ||
      marker.index !== current.index
    ) {
      commitHistory(emptyHistory);
      return;
    }
    // Jump directly to the underlying route/surface entry. Intermediate
    // viewer entries remain valid and are restored if the user goes Forward.
    window.history.go(-(current.index + 1));
  }, [commitHistory]);

  useEffect(() => {
    if (history.entries.length > 0 || !launcherRef.current) return;
    const launcher = launcherRef.current;
    launcherRef.current = null;
    const frame = requestAnimationFrame(() => {
      if (launcher.isConnected && launcher.getClientRects().length > 0)
        launcher.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [history.entries.length]);

  // This listener intentionally remains mounted while the viewer is hidden:
  // Forward from the underlying entry must be able to restore its trail.
  useEffect(() => {
    const onPopState = () => {
      const marker = currentViewerMarker();
      const session = sessionRef.current;
      if (
        marker &&
        session &&
        marker.id === session.id &&
        marker.route === session.route &&
        marker.route === routeRef.current &&
        marker.index < session.entries.length
      ) {
        if (historyRef.current.index < 0)
          launcherRef.current = document.activeElement as HTMLElement | null;
        commitHistory({ entries: session.entries, index: marker.index });
        return;
      }
      if (historyRef.current.index >= 0) commitHistory(emptyHistory);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [commitHistory]);

  useEffect(() => {
    // A route change invalidates the in-memory trail. Old forward markers then
    // cannot resurrect a file on the unrelated route.
    routeRef.current = locationKey ?? '';
    sessionRef.current = undefined;
    if (historyRef.current.index >= 0) commitHistory(emptyHistory);
  }, [commitHistory, locationKey]);

  const open = useCallback(
    (location: FileLocation) => {
      const route = routeRef.current;
      const current = historyRef.current;
      let activeSession = sessionRef.current;
      const currentEntry = current.entries[current.index];
      if (
        activeSession &&
        activeSession.route === route &&
        current.index >= 0 &&
        currentEntry &&
        fileLocationKey(currentEntry.location) === fileLocationKey(location)
      )
        return;

      if (
        current.index < 0 ||
        !activeSession ||
        activeSession.route !== route
      ) {
        if (typeof document !== 'undefined')
          launcherRef.current = document.activeElement as HTMLElement | null;
        activeSession = { id: crypto.randomUUID(), route, entries: [] };
        sessionRef.current = activeSession;
      }

      const entries = activeSession.entries.slice(0, current.index + 1);
      entries.push(createViewerEntry(location));
      activeSession.entries = entries;
      const index = entries.length - 1;
      // pushState naturally discards native forward entries, including any
      // viewer markers that were ahead of the current trail position.
      window.history.pushState(
        {
          ...historyState(),
          [FILE_VIEWER_HISTORY_KEY]: {
            id: activeSession.id,
            index,
            route,
          },
        },
        '',
        window.location.href,
      );
      commitHistory({ entries, index });
    },
    [commitHistory],
  );

  const setMode = (mode: ViewerMode) => {
    const current = historyRef.current;
    const session = sessionRef.current;
    const entry = current.entries[current.index];
    if (!session || !entry) return;
    const entries = current.entries.map((item, index) =>
      index === current.index ? { ...item, mode } : item,
    );
    session.entries = entries.slice();
    commitHistory({ entries, index: current.index });
  };
  const go = (direction: number) => window.history.go(direction);
  const current = history.entries[history.index];
  const value = useMemo(() => ({ open }), [open]);
  return (
    <FileViewerContext.Provider value={value}>
      {children}
      <SurfaceStack
        pages={
          current
            ? [
                {
                  id: `file-viewer-${history.index}`,
                  initialFocus: '[aria-label="Close file viewer"]',
                  title: current.location.path,
                  hideHeader: true,
                  children: (
                    <Suspense
                      fallback={
                        <div className={styles.loading}>
                          <p role="status">Loading file viewer…</p>
                          <button
                            type="button"
                            className={styles.fallbackClose}
                            onClick={close}
                            aria-label="Close file viewer"
                          >
                            Close
                          </button>
                        </div>
                      }
                    >
                      <LazyFileViewer
                        key={history.index}
                        client={dashboardHttpClient}
                        entry={current}
                        canGoBack={history.index > 0}
                        canGoForward={
                          history.index < history.entries.length - 1
                        }
                        onBack={() => go(-1)}
                        onForward={() => go(1)}
                        onClose={close}
                        onModeChange={setMode}
                      />
                    </Suspense>
                  ),
                },
              ]
            : []
        }
        kind="inspector"
        size="wide"
        className={`surface-drawer file-viewer-surface ${styles.surface}`}
        isOpen={Boolean(current)}
        browserHistory={false}
        onDepthChange={close}
        onClose={close}
      />
    </FileViewerContext.Provider>
  );
}

function createViewerEntry(location: FileLocation): ViewerEntry {
  const mode =
    /\.(?:md|markdown)$/i.test(location.path) &&
    location.startLine === undefined
      ? 'preview'
      : 'source';
  return { location, mode, scrollTop: {} };
}

export function useFileViewer(): FileViewerContextValue | undefined {
  return useContext(FileViewerContext);
}
