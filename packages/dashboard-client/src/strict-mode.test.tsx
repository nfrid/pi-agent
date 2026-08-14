import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { parseHTML } from 'linkedom';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { DashboardHttpClient } from './http-client.js';
import {
  type DashboardShellState,
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
  it('keeps one shell subscription under StrictMode and cleans it up', async () => {
    let active = 0;
    let maximum = 0;
    let subscriptions = 0;
    const client = {
      getTrpcClient: async () => ({
        shellSubscribe: {
          subscribe: (
            _input: unknown,
            observer: { onData: (value: unknown) => void },
          ) => {
            subscriptions += 1;
            active += 1;
            maximum = Math.max(maximum, active);
            observer.onData({
              id: 'shell-00000001',
              data: { type: 'caught-up', sequence: 0 },
            });
            return {
              unsubscribe: () => {
                active -= 1;
              },
            };
          },
        },
        sessionSubscribe: {
          subscribe: () => ({ unsubscribe: () => undefined }),
        },
      }),
    } as unknown as DashboardHttpClient;
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
    });
    expect(maximum).toBe(1);
    expect(active).toBe(1);
    expect(subscriptions).toBeGreaterThanOrEqual(1);
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
      dashboard?.store.applyEventEnvelope({
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
