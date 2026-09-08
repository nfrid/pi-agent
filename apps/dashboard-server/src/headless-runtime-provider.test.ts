import { describe, expect, it, vi } from 'vitest';
import { HeadlessRuntimeProvider } from './headless-runtime-provider.js';

describe('headless runtime provider', () => {
  it('forwards the restored process identity through host stop', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const provider = new HeadlessRuntimeProvider('/tmp/runtime-host.sock', {
      client: { stop } as never,
    });

    await provider.stop(
      { runtimeId: 'runtime-restored', processId: 4321 },
      true,
    );

    expect(stop).toHaveBeenCalledWith('runtime-restored', true, 4321);
  });
});
