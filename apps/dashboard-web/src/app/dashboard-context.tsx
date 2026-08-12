import { createContext, useContext } from 'react';
import type { useDashboardShell } from '../dashboard-transport';

export type DashboardContextValue = ReturnType<typeof useDashboardShell>;

export const DashboardContext = createContext<
  DashboardContextValue | undefined
>(undefined);

export function useDashboardContext(): DashboardContextValue {
  const value = useContext(DashboardContext);
  if (!value) throw new Error('Dashboard context is unavailable.');
  return value;
}
