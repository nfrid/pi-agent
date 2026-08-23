import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

export type DashboardUtilityPanel = 'settings';

export type DashboardUtilityContextValue = {
  panel: DashboardUtilityPanel | undefined;
  open: boolean;
  openPanel: (panel: DashboardUtilityPanel) => void;
  close: () => void;
};

export const DashboardUtilityContext = createContext<
  DashboardUtilityContextValue | undefined
>(undefined);

export function DashboardUtilityProvider({
  blocked = false,
  locationKey,
  children,
}: {
  blocked?: boolean;
  locationKey?: string;
  children: ReactNode;
}) {
  const [panel, setPanel] = useState<DashboardUtilityPanel>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (blocked) setOpen(false);
  }, [blocked]);
  useEffect(() => {
    void locationKey;
    setOpen(false);
  }, [locationKey]);
  const value = useMemo<DashboardUtilityContextValue>(
    () => ({
      panel,
      open,
      openPanel: (nextPanel) => {
        if (blocked) return;
        setPanel(nextPanel);
        setOpen(true);
      },
      close: () => setOpen(false),
    }),
    [blocked, open, panel],
  );
  return (
    <DashboardUtilityContext.Provider value={value}>
      {children}
    </DashboardUtilityContext.Provider>
  );
}

/** Optional because a few feature components remain useful in isolation tests. */
export function useDashboardUtility():
  | DashboardUtilityContextValue
  | undefined {
  return useContext(DashboardUtilityContext);
}
