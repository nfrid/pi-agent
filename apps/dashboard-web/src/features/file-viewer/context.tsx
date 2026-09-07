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
import type { FileLocation } from './reference';

const LazyFileViewer = lazy(() =>
  import('./viewer').then(({ FileViewer }) => ({ default: FileViewer })),
);

type ViewerMode = 'source' | 'preview';
type ViewerEntry = {
  location: FileLocation;
  mode: ViewerMode;
  scrollTop: number;
};

type ReadFileClient = {
  readFile(
    input: { path: string; cwd?: string },
    signal?: AbortSignal,
  ): Promise<{ path: string; content: string }>;
};

export type FileViewerContextValue = {
  open(location: FileLocation): void;
};

export const FileViewerContext = createContext<
  FileViewerContextValue | undefined
>(undefined);

function locationKey(location: FileLocation): string {
  return JSON.stringify([
    location.path,
    location.cwd ?? '',
    location.startLine ?? null,
    location.endLine ?? null,
    location.heading ?? null,
  ]);
}

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
  entriesRef.current = entries;
  indexRef.current = index;

  const close = useCallback(() => {
    setEntries((current) => (current.length === 0 ? current : []));
    setIndex(-1);
  }, []);

  useEffect(() => {
    void routeKey;
    close();
  }, [close, routeKey]);

  const open = useCallback((location: FileLocation) => {
    const currentEntries = entriesRef.current;
    const currentIndex = indexRef.current;
    const current = currentEntries[currentIndex];
    if (current && locationKey(current.location) === locationKey(location))
      return;
    const next: ViewerEntry = {
      location,
      mode: initialMode(location),
      scrollTop: 0,
    };
    const base =
      currentIndex >= 0 ? currentEntries.slice(0, currentIndex + 1) : [];
    setEntries([...base, next]);
    setIndex(base.length);
  }, []);

  const updateEntry = useCallback(
    (patch: Partial<Pick<ViewerEntry, 'mode' | 'scrollTop'>>) => {
      setEntries((current) => {
        const currentIndex = indexRef.current;
        const entry = current[currentIndex];
        if (!entry) return current;
        const nextEntry = { ...entry, ...patch };
        if (
          nextEntry.mode === entry.mode &&
          nextEntry.scrollTop === entry.scrollTop
        )
          return current;
        const next = current.slice();
        next[currentIndex] = nextEntry;
        return next;
      });
    },
    [],
  );

  const goBack = useCallback(() => {
    setIndex((current) => Math.max(0, current - 1));
  }, []);
  const goForward = useCallback(() => {
    setIndex((current) => Math.min(entriesRef.current.length - 1, current + 1));
  }, []);

  const current = index >= 0 ? entries[index] : undefined;
  const value = useMemo<FileViewerContextValue>(() => ({ open }), [open]);
  const client = dashboardHttpClient as unknown as ReadFileClient;
  const pages = current
    ? [
        {
          id: 'file-viewer',
          title: current.location.path,
          hideHeader: true,
          children: (
            <Suspense
              fallback={
                <div className={styles.loading} role="status">
                  Loading file viewer…
                </div>
              }
            >
              <LazyFileViewer
                client={client}
                entry={current}
                canGoBack={index > 0}
                canGoForward={index < entries.length - 1}
                onBack={goBack}
                onForward={goForward}
                onClose={close}
                onEntryChange={updateEntry}
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
