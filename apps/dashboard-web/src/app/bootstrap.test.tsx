import { createElement, type ReactNode, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const snapshot = {
  serverId: 'server-compatible',
  revision: 1,
  cursor: 1,
  runtimes: [],
  workspaces: [],
  sessions: [],
  unread: [],
};
const dashboardState = {
  snapshot: undefined as typeof snapshot | undefined,
  error: undefined as string | undefined,
  errorKind: undefined as
    | 'authentication'
    | 'protocol-mismatch'
    | 'network'
    | 'malformed-output'
    | 'domain'
    | 'request'
    | undefined,
  usageError: undefined as string | undefined,
  connectionState: 'connected' as 'connected' | 'blocked' | 'error',
  store: {
    getGeneration: () => 0,
    installSnapshot: vi.fn(),
    setError: vi.fn(),
    updateUsage: vi.fn(),
    setUsageError: vi.fn(),
    reconnect: vi.fn(),
  },
};

vi.mock('@pi-dashboard/client', async () => {
  const actual = await vi.importActual<typeof import('@pi-dashboard/client')>(
    '@pi-dashboard/client',
  );
  return {
    ...actual,
    dashboardHttpClient: {
      usage: () => Promise.resolve({}),
    },
    useDashboardShell: () => {
      const [snapshot, setSnapshot] = useState(dashboardState.snapshot);
      dashboardState.store.installSnapshot.mockImplementation((value) =>
        setSnapshot(value),
      );
      return { ...dashboardState, snapshot };
    },
  };
});

vi.mock('react-aria-components', () => ({
  Button: ({ children, ...props }: { children: ReactNode }) =>
    createElement('button', { type: 'button', ...props }, children),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    RouterProvider: () =>
      createElement(
        'div',
        { 'data-testid': 'router-provider' },
        'current app/store path',
      ),
  };
});

import {
  DashboardHttpError,
  DashboardProtocolMismatchError,
} from '@pi-dashboard/client';
import { DashboardBootstrap, dashboardQueryClient } from './bootstrap';

describe('dashboard startup', () => {
  afterEach(() => {
    dashboardQueryClient.clear();
    dashboardState.snapshot = undefined;
    dashboardState.error = undefined;
    dashboardState.errorKind = undefined;
    dashboardState.connectionState = 'connected';
    vi.clearAllMocks();
  });

  async function renderStartup(
    outcome: unknown,
    initialSnapshot?: typeof snapshot,
  ): Promise<ReactTestRenderer> {
    dashboardState.snapshot =
      outcome instanceof Error ? initialSnapshot : (outcome as typeof snapshot);
    dashboardState.error =
      outcome instanceof Error ? outcome.message : undefined;
    dashboardState.errorKind =
      outcome instanceof DashboardProtocolMismatchError
        ? 'protocol-mismatch'
        : outcome instanceof DashboardHttpError
          ? outcome.kind
          : undefined;
    dashboardState.connectionState =
      dashboardState.errorKind === 'authentication' ||
      dashboardState.errorKind === 'protocol-mismatch'
        ? 'blocked'
        : outcome instanceof Error
          ? 'error'
          : 'connected';
    dashboardQueryClient.setDefaultOptions({
      queries: { retryDelay: 0 },
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(DashboardBootstrap));
    });
    await act(async () => {});
    return renderer;
  }

  it('renders the compatible bootstrap through the current app/store path', async () => {
    const renderer = await renderStartup(snapshot);
    expect(dashboardState.store.installSnapshot).not.toHaveBeenCalled();
    expect(
      renderer.root.findByProps({ 'data-testid': 'router-provider' }),
    ).toBeTruthy();
    expect(
      renderer.root.findByProps({ children: 'current app/store path' }),
    ).toBeTruthy();
  });

  it('blocks startup on a protocol mismatch before auth or routing', async () => {
    const renderer = await renderStartup(
      new DashboardProtocolMismatchError(1, 2, 'old-server'),
    );
    expect(renderer.root.findByProps({ role: 'alert' })).toBeTruthy();
    expect(
      renderer.root.findByProps({ children: 'Dashboard update required' }),
    ).toBeTruthy();
    expect(
      renderer.root.findByProps({ children: 'Reload to update' }),
    ).toBeTruthy();
    expect(renderer.root.findAllByType('form')).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ 'data-testid': 'router-provider' }),
    ).toHaveLength(0);
  });

  it('replaces an established snapshot with AuthPrompt when auth becomes blocked', async () => {
    const renderer = await renderStartup(
      new DashboardHttpError(401, 'expired token', undefined, {
        kind: 'authentication',
      }),
      snapshot,
    );
    expect(
      renderer.root.findByProps({ 'aria-label': 'Dashboard token' }),
    ).toBeTruthy();
    expect(
      renderer.root.findAllByProps({ 'data-testid': 'router-provider' }),
    ).toHaveLength(0);
  });

  it('replaces an established snapshot with reload state on protocol mismatch', async () => {
    const renderer = await renderStartup(
      new DashboardProtocolMismatchError(1, 2, 'old-server'),
      snapshot,
    );
    expect(renderer.root.findByProps({ role: 'alert' })).toBeTruthy();
    expect(
      renderer.root.findByProps({ children: 'Dashboard update required' }),
    ).toBeTruthy();
    expect(
      renderer.root.findAllByProps({ 'data-testid': 'router-provider' }),
    ).toHaveLength(0);
  });

  it('uses the structural authentication classification for AuthPrompt', async () => {
    const renderer = await renderStartup(
      new DashboardHttpError(401, 'not the expected message', undefined, {
        kind: 'authentication',
      }),
    );
    expect(
      renderer.root.findByProps({
        'aria-label': 'Dashboard token',
      }),
    ).toBeTruthy();
    expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ 'data-testid': 'router-provider' }),
    ).toHaveLength(0);
  });

  it.each([
    [
      'network',
      new DashboardHttpError(0, 'network', undefined, { kind: 'network' }),
    ],
    [
      'malformed output',
      new DashboardHttpError(502, 'malformed', undefined, {
        kind: 'malformed-output',
      }),
    ],
  ])('keeps %s startup failures retryable', async (_label, error) => {
    const renderer = await renderStartup(error);
    expect(renderer.root.findByProps({ children: 'Retry' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ type: 'password' })).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ 'data-testid': 'router-provider' }),
    ).toHaveLength(0);
  });
});
