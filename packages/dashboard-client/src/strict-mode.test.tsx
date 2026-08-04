import { parseHTML } from 'linkedom';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { DashboardHttpClient } from './http-client.js';
import { useDashboard } from './index.js';

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
  it('keeps one active SSE stream and removes listeners on unmount', async () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const client = {
      events: async (
        _cursor: number,
        signal: AbortSignal,
        serverId?: string,
      ) => {
        expect(serverId).toBeUndefined();
        calls += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        signal.addEventListener('abort', () => {
          active -= 1;
        });
        if (calls === 1)
          await new Promise<never>((_, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            ),
          );
        return new Response(
          new ReadableStream<Uint8Array>({ start: () => undefined }),
        );
      },
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
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(maximum).toBe(1);
    expect(active).toBe(1);
    await act(async () => {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(active).toBe(0);
  });
});
