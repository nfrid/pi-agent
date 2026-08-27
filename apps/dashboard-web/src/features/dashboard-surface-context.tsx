import {
  createContext,
  type ReactNode,
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
  useEffect(() => {
    if (blocked) setStack([]);
  }, [blocked]);
  useEffect(() => {
    void locationKey;
    setStack([]);
  }, [locationKey]);
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
        setStack((current) => current.slice(0, Math.max(0, depth))),
      close: () => setStack([]),
    }),
    [blocked, stack],
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
