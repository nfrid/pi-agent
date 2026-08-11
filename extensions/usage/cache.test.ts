import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { createSharedUsageQuery, resetSharedUsageState } from './cache';
import type { UsageReport } from './types';

function context(provider: string, id: string): ExtensionContext {
  return {
    model: { provider, id, name: id },
  } as unknown as ExtensionContext;
}

function report(limitId: string): UsageReport {
  return {
    capturedAt: Date.now(),
    snapshots: [{ limitId }],
  };
}

afterEach(() => resetSharedUsageState());

describe('process usage cache', () => {
  it('shares a fresh provider report while keeping providers separate', async () => {
    const calls: string[] = [];
    const query = async (ctx: ExtensionContext): Promise<UsageReport> => {
      calls.push(ctx.model?.provider ?? 'unknown');
      return report(ctx.model?.provider ?? 'unknown');
    };
    const shared = createSharedUsageQuery(query, {
      freshMs: 60_000,
      stable: true,
    });
    const first = context('provider-a', 'model-a');
    const second = context('provider-a', 'model-b');
    const other = context('provider-b', 'model-a');

    const firstReport = await shared(first, new AbortController().signal);
    const reused = await shared(second, new AbortController().signal);
    const otherReport = await shared(other, new AbortController().signal);

    expect(calls).toEqual(['provider-a', 'provider-b']);
    expect(reused).toBe(firstReport);
    expect(otherReport.snapshots[0]?.limitId).toBe('provider-b');
  });

  it('expires based on cache insertion, not a stale report timestamp', async () => {
    let calls = 0;
    const shared = createSharedUsageQuery(
      async (): Promise<UsageReport> => {
        calls++;
        return { capturedAt: 0, snapshots: [{ limitId: `report-${calls}` }] };
      },
      { freshMs: 60_000, stable: true },
    );
    const first = await shared(
      context('provider-a', 'model-a'),
      new AbortController().signal,
    );
    const second = await shared(
      context('provider-a', 'model-a'),
      new AbortController().signal,
    );

    expect(calls).toBe(1);
    expect(second).toBe(first);
  });

  it('bypasses a fresh cache entry when forced', async () => {
    let calls = 0;
    const shared = createSharedUsageQuery(
      async (): Promise<UsageReport> => {
        calls++;
        return report(`report-${calls}`);
      },
      { freshMs: 60_000, stable: true },
    );
    const ctx = context('provider-a', 'model-a');
    await shared(ctx, new AbortController().signal);
    const refreshed = await shared(ctx, new AbortController().signal, {
      force: true,
    });

    expect(calls).toBe(2);
    expect(refreshed.snapshots[0]?.limitId).toBe('report-2');
  });

  it('does not let one session cancellation cancel shared physical work', async () => {
    let resolve!: (value: UsageReport) => void;
    const query = () =>
      new Promise<UsageReport>((done) => {
        resolve = done;
      });
    const shared = createSharedUsageQuery(query, {
      freshMs: 60_000,
      stable: true,
    });
    const firstController = new AbortController();
    const first = shared(
      context('provider-a', 'model-a'),
      firstController.signal,
    );
    const second = shared(
      context('provider-a', 'model-a'),
      new AbortController().signal,
    );

    firstController.abort(new Error('session closed'));
    await expect(first).rejects.toThrow('session closed');
    resolve(report('provider-a'));
    await expect(second).resolves.toMatchObject({
      snapshots: [{ limitId: 'provider-a' }],
    });
  });
});
