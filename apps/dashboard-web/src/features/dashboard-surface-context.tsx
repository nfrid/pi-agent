import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

export type DashboardSurface =
  | { type: 'settings' }
  | { type: 'usage-analytics' };

export type DashboardSurfaceContextValue = {
  stack: readonly DashboardSurface[];
  open: (surface: DashboardSurface) => void;
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
  const clear = useCallback(
    () => setStack((current) => (current.length === 0 ? current : [])),
    [],
  );
  useEffect(() => {
    if (blocked) clear();
  }, [blocked, clear]);
  useEffect(() => {
    void locationKey;
    clear();
  }, [clear, locationKey]);
  const value = useMemo<DashboardSurfaceContextValue>(
    () => ({
      stack,
      open: (surface) => {
        if (blocked) return;
        setStack((current) =>
          surfaceKey(current.at(-1) ?? surface) === surfaceKey(surface) &&
          current.length > 0
            ? current
            : [...current, surface],
        );
      },
      truncate: (depth) =>
        setStack((current) => {
          const length = Math.min(current.length, Math.max(0, depth));
          return length === current.length ? current : current.slice(0, length);
        }),
      close: clear,
    }),
    [blocked, clear, stack],
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
