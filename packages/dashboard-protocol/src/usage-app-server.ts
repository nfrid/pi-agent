import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const TIMEOUT_MS = 15_000;
export interface UsageReport {
  capturedAt: number;
  snapshots: unknown[];
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Codex app-server query aborted.');
}
function normalize(value: unknown): UsageReport {
  const root =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const limits = root.rateLimits ?? root.rate_limits;
  const snapshots: unknown[] = [];
  if (limits && typeof limits === 'object') {
    const record = limits as Record<string, unknown>;
    if (
      'primary' in record ||
      'secondary' in record ||
      'primary_window' in record ||
      'secondary_window' in record
    ) {
      snapshots.push({
        limitId: 'codex',
        primary: record.primary ?? record.primary_window,
        secondary: record.secondary ?? record.secondary_window,
      });
    } else {
      for (const [limitId, raw] of Object.entries(record)) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        const primary = item.primary ?? item.primary_window;
        const secondary = item.secondary ?? item.secondary_window;
        if (primary || secondary)
          snapshots.push({ limitId, primary, secondary });
      }
    }
  }
  if (!snapshots.length)
    throw new Error('Codex app-server returned no rate-limit windows.');
  return { capturedAt: Date.now(), snapshots };
}

export async function queryViaCodexAppServer(
  signal: AbortSignal,
): Promise<UsageReport> {
  signal.throwIfAborted();
  const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  let stderr = '';
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const fail = (error: Error) => {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  const timer = setTimeout(() => {
    child.kill();
    fail(new Error('Timed out waiting for codex app-server.'));
  }, TIMEOUT_MS);
  const onAbort = () => {
    child.kill();
    fail(abortError(signal));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr = `${stderr}${String(chunk)}`.slice(-64 * 1024);
  });
  child.once('exit', () =>
    fail(
      new Error(
        stderr.trim()
          ? `codex app-server exited.\nCodex stderr: ${stderr.trim()}`
          : 'codex app-server exited.',
      ),
    ),
  );
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const response = JSON.parse(line) as {
        id?: unknown;
        result?: unknown;
        error?: { message?: unknown };
      };
      if (typeof response.id !== 'number') return;
      const item = pending.get(response.id);
      if (!item) return;
      pending.delete(response.id);
      if (response.error)
        item.reject(
          new Error(String(response.error.message ?? 'unknown error')),
        );
      else item.resolve(response.result);
    } catch {
      /* malformed app-server output is ignored */
    }
  });
  const request = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    const promise = new Promise<unknown>((resolve, reject) =>
      pending.set(id, { resolve, reject }),
    );
    child.stdin.write(
      `${JSON.stringify(params === undefined ? { method, id } : { method, id, params })}\n`,
    );
    return promise;
  };
  try {
    await request('initialize', {
      clientInfo: { name: 'pi_usage', title: 'Pi Usage', version: '0.1.0' },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    return normalize(await request('account/rateLimits/read'));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    fail(new Error('codex app-server disposed.'));
    child.stdin.end();
    child.kill();
  }
}
