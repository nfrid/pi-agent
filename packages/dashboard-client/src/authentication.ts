export const DASHBOARD_TOKEN_KEY = 'pi-dashboard-token';

export interface DashboardTokenStore {
  get(): string | undefined;
  set(token: string): void;
  clear(): void;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Browser token storage. Tokens are deliberately never put in request URLs. */
export function createDashboardTokenStore(
  storage:
    | Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
    | undefined = browserStorage(),
): DashboardTokenStore {
  return {
    get() {
      try {
        return storage?.getItem(DASHBOARD_TOKEN_KEY) ?? undefined;
      } catch {
        return undefined;
      }
    },
    set(token) {
      storage?.setItem(DASHBOARD_TOKEN_KEY, token);
    },
    clear() {
      storage?.removeItem(DASHBOARD_TOKEN_KEY);
    },
  };
}

export const browserDashboardTokenStore = createDashboardTokenStore();

export function dashboardToken(): string | undefined {
  return browserDashboardTokenStore.get();
}

export function saveDashboardToken(token: string): void {
  browserDashboardTokenStore.set(token.trim());
}

export function clearDashboardToken(): void {
  browserDashboardTokenStore.clear();
}
