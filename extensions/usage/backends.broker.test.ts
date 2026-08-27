import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getScopedServices,
  releaseScopedServices,
} from '../shared/runtime/scoped-services';
import { queryUsage } from './backends';

const scope = 'usage-broker-test';

function context(): ExtensionContext {
  return {
    sessionManager: { getSessionId: () => scope },
  } as unknown as ExtensionContext;
}

afterEach(() => releaseScopedServices(scope));

describe('dashboard usage broker', () => {
  it('reads normalized usage through the scoped dashboard bridge', async () => {
    const read = vi.fn(async () => ({
      usage: { capturedAt: 123, snapshots: [{ limitId: 'codex' }] },
    }));
    getScopedServices(scope).dashboardUsage = { read };
    const signal = new AbortController().signal;

    await expect(queryUsage(context(), signal, true)).resolves.toEqual({
      capturedAt: 123,
      snapshots: [{ limitId: 'codex' }],
    });
    expect(read).toHaveBeenCalledWith(true, signal);
  });

  it('does not make a second provider request after a broker-side error', async () => {
    getScopedServices(scope).dashboardUsage = {
      read: async () => ({ error: 'provider unavailable' }),
    };

    await expect(
      queryUsage(context(), new AbortController().signal),
    ).rejects.toThrow('provider unavailable');
  });

  it('uses a stale broker snapshot when its refresh reports an error', async () => {
    getScopedServices(scope).dashboardUsage = {
      read: async () => ({
        usage: { capturedAt: 456, snapshots: [] },
        error: 'provider unavailable',
      }),
    };

    await expect(
      queryUsage(context(), new AbortController().signal),
    ).resolves.toEqual({ capturedAt: 456, snapshots: [] });
  });
});
