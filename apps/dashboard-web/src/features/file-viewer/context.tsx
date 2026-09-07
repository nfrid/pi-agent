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

type FileViewerContextValue = { open(location: FileLocation): void };
export const FileViewerContext = createContext<
  FileViewerContextValue | undefined
>(undefined);

type History = { entries: readonly ViewerEntry[]; index: number };
const emptyHistory: History = { entries: [], index: -1 };

export function FileViewerProvider({
  children,
  locationKey,
}: {
  children: ReactNode;
  locationKey?: string;
}) {
  const [history, setHistory] = useState<History>(emptyHistory);
  const launcherRef = useRef<HTMLElement | null>(null);
  const close = useCallback(() => setHistory(emptyHistory), []);
  useEffect(() => {
    void locationKey;
    close();
  }, [close, locationKey]);
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

  const open = useCallback(
    (location: FileLocation) => {
      if (history.entries.length === 0 && typeof document !== 'undefined')
        launcherRef.current = document.activeElement as HTMLElement | null;
      setHistory((current) => {
        const entry = current.entries[current.index];
        if (
          entry &&
          fileLocationKey(entry.location) === fileLocationKey(location)
        )
          return current;
        const entries = current.entries.slice(0, current.index + 1);
        const mode =
          /\.(?:md|markdown)$/i.test(location.path) &&
          location.startLine === undefined
            ? 'preview'
            : 'source';
        return {
          entries: [...entries, { location, mode, scrollTop: {} }],
          index: entries.length,
        };
      });
    },
    [history.entries.length],
  );
  const go = (direction: number) =>
    setHistory((current) => ({
      ...current,
      index: Math.max(
        0,
        Math.min(current.entries.length - 1, current.index + direction),
      ),
    }));
  const setMode = (mode: ViewerMode) =>
    setHistory((current) => ({
      ...current,
      entries: current.entries.map((entry, index) =>
        index === current.index ? { ...entry, mode } : entry,
      ),
    }));
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
                  id: 'file-viewer',
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
        onDepthChange={close}
        onClose={close}
      />
    </FileViewerContext.Provider>
  );
}

export function useFileViewer(): FileViewerContextValue | undefined {
  return useContext(FileViewerContext);
}
