import { useEffect, useRef, useState } from 'react';
import styles from './pwa-update.module.css';

declare const __DASHBOARD_BUILD_ID__: string;

const VERSION_URL = '/version.json';
export const UPDATE_POLL_INTERVAL_MS = 60_000;

export function shouldCheckDashboardVersion(
  lastCheckedAt: number,
  now: number,
): boolean {
  return lastCheckedAt === 0 || now - lastCheckedAt >= UPDATE_POLL_INTERVAL_MS;
}

export function dashboardVersion(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const version = (value as Record<string, unknown>).version;
  return typeof version === 'string' && version.length > 0
    ? version
    : undefined;
}

export function dashboardUpdateAvailable(
  currentVersion: string,
  latestVersion: string | undefined,
): boolean {
  return latestVersion !== undefined && latestVersion !== currentVersion;
}

let pendingVersionRequest: Promise<string | undefined> | undefined;

export function fetchDashboardVersion(
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  if (pendingVersionRequest) return pendingVersionRequest;
  const request = (async () => {
    try {
      const response = await fetcher(VERSION_URL, { cache: 'no-store' });
      if (!response.ok) return undefined;
      return dashboardVersion(await response.json());
    } catch {
      return undefined;
    }
  })();
  pendingVersionRequest = request;
  void request.finally(() => {
    if (pendingVersionRequest === request) pendingVersionRequest = undefined;
  });
  return request;
}

async function reloadDashboard(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
  } finally {
    window.location.reload();
  }
}

export function UpdateAvailablePrompt() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [reloading, setReloading] = useState(false);
  const lastCheckedAtRef = useRef(0);

  useEffect(() => {
    let active = true;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (!shouldCheckDashboardVersion(lastCheckedAtRef.current, now)) return;
      lastCheckedAtRef.current = now;
      const latestVersion = await fetchDashboardVersion();
      if (
        active &&
        dashboardUpdateAvailable(__DASHBOARD_BUILD_ID__, latestVersion)
      )
        setUpdateAvailable(true);
    };
    const checkWhenVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };

    void check();
    const interval = window.setInterval(
      () => void check(),
      UPDATE_POLL_INTERVAL_MS,
    );
    window.addEventListener('focus', checkWhenVisible);
    document.addEventListener('visibilitychange', checkWhenVisible);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', checkWhenVisible);
      document.removeEventListener('visibilitychange', checkWhenVisible);
    };
  }, []);

  if (!updateAvailable) return null;
  return (
    <aside className={styles.prompt} role="status" aria-live="polite">
      <span>
        <strong>Update available</strong>
        <small>A new dashboard version is ready.</small>
      </span>
      <button
        type="button"
        disabled={reloading}
        onClick={() => {
          setReloading(true);
          void reloadDashboard();
        }}
      >
        {reloading ? 'Updating…' : 'Reload to update'}
      </button>
    </aside>
  );
}
