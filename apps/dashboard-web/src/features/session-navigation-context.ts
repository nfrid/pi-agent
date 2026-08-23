import { createContext, useContext } from 'react';

export type SessionNavigationState = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

export const SessionNavigationContext =
  createContext<SessionNavigationState | null>(null);

export function useSessionNavigation(): SessionNavigationState | null {
  return useContext(SessionNavigationContext);
}
