import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { parseHTML } from 'linkedom';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { DashboardHttpClient } from './http-client.js';
import {
  type DashboardShellState,
  HIDDEN_STREAM_STALE_MS,
  shouldReconnectAfterVisibility,
  useDashboard,
  useDashboardShell,
} from './index.js';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const { document, window } = parseHTML('<!doctype html><body></body>');
Object.assign(globalThis, {
  document,
  window,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { onLine: true },
});

describe('useDashboard StrictMode lifecycle', () => {
  it('reconnects only stale or disconnected visible streams', () => {
    expect(shouldReconnectAfterVisibility('connected', undefined, 20_000)).toBe(
      false,
    );
    expect(
      shouldReconnectAfterVisibility('reconnecting', undefined, 20_000),
    ).toBe(true);
    expect(
      shouldReconnectAfterVisibility(
        'connected',
        5_000,
        5_000 + HIDDEN_STREAM_STALE_MS - 1,
      ),
    ).toBe(false);
    expect(
      shouldReconnectAfterVisibility(
        'connected',
        5_000,
        5_000 + HIDDEN_STREAM_STALE_MS,
      ),
    ).toBe(true);
  });

  it('keeps one active SSE stream and removes listeners on unmount', async () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    let snapshots = 0;
    let releaseSnapshot!: () => void;
    const snapshotReady = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const client = new DashboardHttpClient({
      fetch: async (input, init) => {
        if (String(input) === '/api/snapshot') {
          snapshots += 1;
          await snapshotReady;
          return new Response(
            JSON.stringify({
              serverId: 'daemon-1',
              revision: 7,
              cursor: 7,
              runtimes: [],
              workspaces: [],
              sessions: [],
              unread: [],
            }),
            { status: 200 },
          );
        }
        expect(String(input)).toBe('/api/events?cursor=7&serverId=daemon-1');
        calls += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        const signal = init?.signal;
        if (!signal) throw new Error('Expected an SSE abort signal.');
        await new Promise<never>((_, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              active -= 1;
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          ),
        );
        throw new Error('unreachable');
      },
      tokenStore: {
        get: () => 'test-token',
        set: () => undefined,
        clear: () => undefined,
      },
    });
    function Probe() {
      useDashboard(client);
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      releaseSnapshot();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(snapshots).toBe(1);
    expect(calls).toBe(1);
    expect(maximum).toBe(1);
    expect(active).toBe(1);
    await act(async () => {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(active).toBe(0);
  });

  it('does not rerender the application shell for transcript-only records', async () => {
    const client = {
      snapshot: async () => ({
        serverId: 'daemon-1',
        revision: 1,
        cursor: 1,
        runtimes: [],
        workspaces: [],
        sessions: [],
        unread: [],
      }),
      events: async () =>
        new Response(
          new ReadableStream<Uint8Array>({ start: () => undefined }),
        ),
    } as unknown as DashboardHttpClient;
    let dashboard: DashboardShellState | undefined;
    let renders = 0;
    function Probe() {
      dashboard = useDashboardShell(client);
      renders += 1;
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      dashboard?.store.installSnapshot({
        serverId: 'daemon-1',
        revision: 1,
        cursor: 1,
        runtimes: [],
        workspaces: [],
        sessions: [],
        unread: [],
      } as unknown as BrowserSnapshot);
    });
    const rendersAfterSnapshot = renders;
    await act(async () => {
      dashboard?.store.acceptStreamRecord({
        cursor: 2,
        emittedAt: 2,
        sessionId: 'session-1',
        event: { type: 'agent.settled', sessionId: 'session-1' },
      });
    });
    expect(renders).toBe(rendersAfterSnapshot);
    await act(async () => root.unmount());
  });
});
