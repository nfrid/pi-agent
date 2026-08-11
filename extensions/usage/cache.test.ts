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

  it('does not let one session cancellation cancel shared physical work', async () => {
    let resolve!: (value: UsageReport) => void;
    const query = () => new Promise<UsageReport>((done) => (resolve = done));
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
