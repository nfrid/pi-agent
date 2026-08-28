import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

export type DashboardSurface =
  | { type: 'settings' }
  | { type: 'usage-analytics' }
  | { type: 'command-palette' }
  | { type: 'new-thread-project' };

export type DashboardSurfaceContextValue = {
  stack: readonly DashboardSurface[];
  open: (surface: DashboardSurface) => void;
  replace: (surface: DashboardSurface) => void;
  truncate: (depth: number) => void;
  close: () => void;
};

export const DashboardSurfaceContext = createContext<
  DashboardSurfaceContextValue | undefined
>(undefined);

function surfaceKey(surface: DashboardSurface): string {
  return surface.type;
}

export function DashboardSurfaceProvider({
  blocked = false,
  locationKey,
  children,
}: {
  blocked?: boolean;
  locationKey?: string;
  children: ReactNode;
}) {
  const [stack, setStack] = useState<readonly DashboardSurface[]>([]);
  const launcherRef = useRef<HTMLElement | null>(null);
  const rememberLauncher = useCallback(() => {
    if (stack.length === 0 && typeof document !== 'undefined')
      launcherRef.current = document.activeElement as HTMLElement | null;
  }, [stack.length]);
  const clear = useCallback(
    () => setStack((current) => (current.length === 0 ? current : [])),
    [],
  );
  useEffect(() => {
    if (blocked) clear();
  }, [blocked, clear]);
  useEffect(() => {
    if (stack.length > 0 || !launcherRef.current) return;
    const launcher = launcherRef.current;
    launcherRef.current = null;
    const frame = requestAnimationFrame(() => {
      if (launcher.isConnected && launcher.getClientRects().length > 0)
        launcher.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [stack.length]);
  useEffect(() => {
    void locationKey;
    clear();
  }, [clear, locationKey]);
  const value = useMemo<DashboardSurfaceContextValue>(
    () => ({
      stack,
      open: (surface) => {
        if (blocked) return;
        rememberLauncher();
        setStack((current) =>
          surfaceKey(current.at(-1) ?? surface) === surfaceKey(surface) &&
          current.length > 0
            ? current
            : [...current, surface],
        );
      },
      replace: (surface) => {
        if (blocked) return;
        rememberLauncher();
        setStack((current) =>
          current.length === 1 &&
          surfaceKey(current[0] ?? surface) === surfaceKey(surface)
            ? current
            : [surface],
        );
      },
      truncate: (depth) =>
        setStack((current) => {
          const length = Math.min(current.length, Math.max(0, depth));
          return length === current.length ? current : current.slice(0, length);
        }),
      close: clear,
    }),
    [blocked, clear, rememberLauncher, stack],
  );
  return (
    <DashboardSurfaceContext.Provider value={value}>
      {children}
    </DashboardSurfaceContext.Provider>
  );
}

/** Optional because feature components remain useful in isolation tests. */
export function useDashboardSurfaces():
  | DashboardSurfaceContextValue
  | undefined {
  return useContext(DashboardSurfaceContext);
}
