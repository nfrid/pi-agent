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
import {
  fileLocationKey,
  type ViewerEntry,
  type ViewerMode,
  type ViewerScrollPositions,
} from './model';
import type { FileLocation } from './reference';

const LazyFileViewer = lazy(() =>
  import('./viewer').then(({ FileViewer }) => ({ default: FileViewer })),
);

export type { ViewerEntry, ViewerMode, ViewerScrollPositions } from './model';

export type FileViewerContextValue = {
  open(location: FileLocation): void;
};

export const FileViewerContext = createContext<
  FileViewerContextValue | undefined
>(undefined);

function isMarkdown(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}

function initialMode(location: FileLocation): ViewerMode {
  return isMarkdown(location.path) &&
    location.startLine === undefined &&
    location.endLine === undefined
    ? 'preview'
    : 'source';
}

export function FileViewerProvider({
  children,
  locationKey: routeKey,
}: {
  children: ReactNode;
  locationKey?: string;
}) {
  const [entries, setEntries] = useState<readonly ViewerEntry[]>([]);
  const [index, setIndex] = useState(-1);
  const entriesRef = useRef(entries);
  const indexRef = useRef(index);
  const launcherRef = useRef<HTMLElement | null>(null);
  const scrollPositionsRef = useRef(new Map<string, ViewerScrollPositions>());
  entriesRef.current = entries;
  indexRef.current = index;

  const close = useCallback(() => {
    scrollPositionsRef.current.clear();
    setEntries((current) => (current.length === 0 ? current : []));
    setIndex(-1);
  }, []);

  useEffect(() => {
    void routeKey;
    close();
  }, [close, routeKey]);

  useEffect(() => {
    if (entries.length > 0 || !launcherRef.current) return;
    const launcher = launcherRef.current;
    launcherRef.current = null;
    const frame = requestAnimationFrame(() => {
      if (launcher.isConnected && launcher.getClientRects().length > 0)
        launcher.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [entries.length]);

  const open = useCallback((location: FileLocation) => {
    const currentEntries = entriesRef.current;
    const currentIndex = indexRef.current;
    const current = currentEntries[currentIndex];
    if (
      current &&
      fileLocationKey(current.location) === fileLocationKey(location)
    )
      return;
    if (currentEntries.length === 0 && typeof document !== 'undefined')
      launcherRef.current = document.activeElement as HTMLElement | null;
    const next: ViewerEntry = {
      location,
      mode: initialMode(location),
      scrollTop: {},
    };
    const base =
      currentIndex >= 0 ? currentEntries.slice(0, currentIndex + 1) : [];
    for (const discarded of currentEntries.slice(currentIndex + 1))
      scrollPositionsRef.current.delete(fileLocationKey(discarded.location));
    setEntries([...base, next]);
    setIndex(base.length);
  }, []);

  const updateMode = useCallback((mode: ViewerMode) => {
    setEntries((current) => {
      const currentIndex = indexRef.current;
      const entry = current[currentIndex];
      if (!entry || entry.mode === mode) return current;
      const next = current.slice();
      next[currentIndex] = { ...entry, mode };
      return next;
    });
  }, []);
  const updateScroll = useCallback(
    (location: FileLocation, mode: ViewerMode, scrollTop: number) => {
      const key = fileLocationKey(location);
      const prior = scrollPositionsRef.current.get(key) ?? {};
      if (prior[mode] === scrollTop) return;
      scrollPositionsRef.current.set(key, { ...prior, [mode]: scrollTop });
    },
    [],
  );

  const goBack = useCallback(() => {
    setIndex((current) => Math.max(0, current - 1));
  }, []);
  const goForward = useCallback(() => {
    setIndex((current) => Math.min(entriesRef.current.length - 1, current + 1));
  }, []);

  const currentBase = index >= 0 ? entries[index] : undefined;
  const current = currentBase
    ? {
        ...currentBase,
        scrollTop: {
          ...currentBase.scrollTop,
          ...scrollPositionsRef.current.get(
            fileLocationKey(currentBase.location),
          ),
        },
      }
    : undefined;
  const value = useMemo<FileViewerContextValue>(() => ({ open }), [open]);
  const pages = current
    ? [
        {
          id: 'file-viewer',
          title: current.location.path,
          hideHeader: true,
          children: (
            <Suspense
              fallback={
                <div className={styles.viewer}>
                  <header className={styles.header}>
                    <div className={styles.heading}>
                      <span className={styles.eyebrow}>File viewer</span>
                      <h2>{current.location.path}</h2>
                      <span className={styles.diskStatus}>Loading…</span>
                    </div>
                    <button
                      type="button"
                      className={styles.fallbackClose}
                      onClick={close}
                      aria-label="Close file viewer"
                    >
                      Close
                    </button>
                  </header>
                  <div className={styles.loading} role="status">
                    Loading file viewer…
                  </div>
                </div>
              }
            >
              <LazyFileViewer
                client={dashboardHttpClient}
                entry={current}
                canGoBack={index > 0}
                canGoForward={index < entries.length - 1}
                onBack={goBack}
                onForward={goForward}
                onClose={close}
                onModeChange={updateMode}
                onScroll={updateScroll}
              />
            </Suspense>
          ),
        },
      ]
    : [];

  return (
    <FileViewerContext.Provider value={value}>
      {children}
      <SurfaceStack
        pages={pages}
        kind="inspector"
        size="wide"
        className={`surface-drawer file-viewer-surface ${styles.surface}`}
        isOpen={pages.length > 0}
        onDepthChange={() => undefined}
        onClose={close}
      />
    </FileViewerContext.Provider>
  );
}

/** File links are optional consumers, so callers outside the provider get no-op behavior. */
export function useFileViewer(): FileViewerContextValue | undefined {
  return useContext(FileViewerContext);
}
