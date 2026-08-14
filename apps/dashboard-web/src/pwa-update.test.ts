import { describe, expect, it, vi } from 'vitest';
import {
  dashboardUpdateAvailable,
  dashboardVersion,
  fetchDashboardVersion,
  reloadDashboard,
  shouldCheckDashboardVersion,
  UPDATE_POLL_INTERVAL_MS,
} from './pwa-update';

describe('dashboard PWA updates', () => {
  it('accepts only non-empty version payloads', () => {
    expect(dashboardVersion({ version: 'release-2' })).toBe('release-2');
    expect(dashboardVersion({ version: '' })).toBeUndefined();
    expect(dashboardVersion({ version: 2 })).toBeUndefined();
    expect(dashboardVersion(undefined)).toBeUndefined();
  });

  it('detects a release only when its build ID differs', () => {
    expect(dashboardUpdateAvailable('release-1', 'release-2')).toBe(true);
    expect(dashboardUpdateAvailable('release-1', 'release-1')).toBe(false);
    expect(dashboardUpdateAvailable('release-1', undefined)).toBe(false);
  });

  it('does not repeat focus checks inside the polling interval', () => {
    expect(shouldCheckDashboardVersion(0, 10)).toBe(true);
    expect(
      shouldCheckDashboardVersion(10, 10 + UPDATE_POLL_INTERVAL_MS - 1),
    ).toBe(false);
    expect(shouldCheckDashboardVersion(10, 10 + UPDATE_POLL_INTERVAL_MS)).toBe(
      true,
    );
  });

  it('checks the uncached version endpoint and tolerates failures', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ version: 'release-2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(fetchDashboardVersion(fetcher)).resolves.toBe('release-2');
    expect(fetcher).toHaveBeenCalledWith('/version.json', {
      cache: 'no-store',
    });

    fetcher.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchDashboardVersion(fetcher)).resolves.toBeUndefined();
  });

  it('reloads through a waiting worker after requesting an update', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.fn();
    const reload = vi.fn();
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({
          update,
          waiting: { postMessage },
        }),
      },
    });
    vi.stubGlobal('window', { location: { reload } });
    try {
      await reloadDashboard();
      expect(update).toHaveBeenCalledOnce();
      expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reloads without a worker and when an update request fails', async () => {
    const reload = vi.fn();
    const update = vi.fn().mockRejectedValue(new Error('offline'));
    const postMessage = vi.fn();
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({
          update,
          waiting: undefined,
        }),
      },
    });
    vi.stubGlobal('window', { location: { reload } });
    try {
      await reloadDashboard();
      expect(update).toHaveBeenCalledOnce();
      expect(postMessage).not.toHaveBeenCalled();
      expect(reload).toHaveBeenCalledOnce();

      vi.stubGlobal('navigator', { serviceWorker: undefined });
      await reloadDashboard();
      expect(reload).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shares overlapping focus, visibility, and interval checks', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((next) => {
          resolve = next;
        }),
    );
    const checks = [
      fetchDashboardVersion(fetcher),
      fetchDashboardVersion(fetcher),
      fetchDashboardVersion(fetcher),
    ];

    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(
      new Response(JSON.stringify({ version: 'release-2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(Promise.all(checks)).resolves.toEqual([
      'release-2',
      'release-2',
      'release-2',
    ]);
  });
});
