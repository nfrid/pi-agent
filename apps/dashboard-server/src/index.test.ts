import { afterEach, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  port: 1234,
  socketPath: '/tmp/test-bridge.sock',
  token: 'test-token',
}));
vi.mock('./create-daemon.js', () => ({ createDaemon: async () => server }));

import { runDashboard } from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
  server.stop.mockReset().mockResolvedValue(undefined);
});

it.each([
  false,
  true,
])('reports shutdown failure=%s through the process exit status', async (fails) => {
  let shutdown: (() => void) | undefined;
  vi.spyOn(process, 'once').mockImplementation((event, listener) => {
    if (event === 'SIGTERM') shutdown = listener as () => void;
    return process;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const exit = vi
    .spyOn(process, 'exit')
    .mockImplementation(() => undefined as never);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const failure = new AggregateError(
    [new Error('cleanup failed')],
    'Dashboard teardown failed',
  );
  if (fails) server.stop.mockRejectedValueOnce(failure);
  await runDashboard();
  shutdown?.();
  shutdown?.();
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(fails ? 1 : 0));
  expect(server.stop).toHaveBeenCalledTimes(1);
  if (fails)
    expect(error).toHaveBeenCalledWith('Dashboard shutdown failed:', failure);
  else expect(error).not.toHaveBeenCalled();
});
