import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  getTrpcClient: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock('@pi-dashboard/client', () => ({ dashboardHttpClient: transport }));

beforeEach(() => {
  vi.resetModules();
  transport.getTrpcClient
    .mockReset()
    .mockResolvedValue({ telemetryReport: { mutate: transport.mutate } });
  transport.mutate.mockReset().mockResolvedValue({ accepted: true });
  const window = Object.assign(new EventTarget(), {
    location: { pathname: '/sessions/session-1' },
  });
  vi.stubGlobal('window', window);
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(() => vi.unstubAllGlobals());

describe('browser telemetry', () => {
  it('captures exceptions and rejections without messages, stacks, URLs or error objects', async () => {
    const { installBrowserTelemetry, flushBrowserTelemetry } = await import(
      './telemetry'
    );
    const uninstall = installBrowserTelemetry();
    const error = Object.assign(new Event('error'), {
      message: 'PRIVATE',
      filename: '/private/path',
      error: new Error('PRIVATE'),
    });
    window.dispatchEvent(error);
    await vi.waitFor(() => expect(transport.mutate).toHaveBeenCalledOnce());
    window.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), {
        reason: 'PRIVATE SECRET',
      }),
    );
    await vi.waitFor(() => expect(transport.mutate).toHaveBeenCalledTimes(2));
    expect(transport.mutate.mock.calls.map(([input]) => input.code)).toEqual([
      'uncaught-error',
      'unhandled-rejection',
    ]);
    expect(JSON.stringify(transport.mutate.mock.calls)).not.toContain(
      'PRIVATE',
    );
    expect(transport.mutate.mock.calls[0][0]).toMatchObject({
      sessionId: 'session-1',
      version: expect.any(String),
    });
    uninstall();
    window.dispatchEvent(error);
    await flushBrowserTelemetry();
    expect(transport.mutate).toHaveBeenCalledTimes(2);
  });
  it('buffers at most 20 offline observations and flushes them on reconnect', async () => {
    const { reportBrowserTelemetry, flushBrowserTelemetry } = await import(
      './telemetry'
    );
    vi.stubGlobal('navigator', { onLine: false });
    for (let index = 0; index < 30; index++)
      reportBrowserTelemetry('connection-error');
    expect(transport.mutate).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', { onLine: true });
    await flushBrowserTelemetry();
    expect(transport.mutate).toHaveBeenCalledTimes(20);
  });
  it('retains failed sends for a later retry without reporting its own failures', async () => {
    const { reportBrowserTelemetry, flushBrowserTelemetry } = await import(
      './telemetry'
    );
    transport.mutate.mockRejectedValueOnce(new Error('offline'));
    reportBrowserTelemetry('render-error');
    await vi.waitFor(() => expect(transport.mutate).toHaveBeenCalledOnce());
    await flushBrowserTelemetry();
    expect(transport.mutate).toHaveBeenCalledTimes(2);
    expect(transport.mutate.mock.calls.map(([input]) => input.code)).toEqual([
      'render-error',
      'render-error',
    ]);
  });
  it('returns the explicit report result so the UI does not claim an unsuccessful write succeeded', async () => {
    const { reportDashboardQuirk } = await import('./telemetry');
    transport.mutate.mockResolvedValueOnce({ accepted: false });
    expect(await reportDashboardQuirk('Stale widget')).toBe(false);
    expect(transport.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'manual-report', note: 'Stale widget' }),
    );
  });
});
