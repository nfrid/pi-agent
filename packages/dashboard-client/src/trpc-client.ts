import type { DashboardRouter } from '@pi-dashboard/server/trpc';
import { createTRPCClient, httpLink, type TRPCClient } from '@trpc/client';
import type { DashboardTokenStore } from './authentication.js';

export type DashboardTrpcFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface DashboardTrpcClientOptions {
  baseUrl: string;
  fetch: DashboardTrpcFetch;
  tokenStore: DashboardTokenStore;
}

/**
 * The finite dashboard tRPC boundary. The router import is type-only so the
 * server package and its Node dependencies cannot enter the browser bundle.
 */
export function createDashboardTrpcClient(
  options: DashboardTrpcClientOptions,
): TRPCClient<DashboardRouter> {
  return createTRPCClient<DashboardRouter>({
    links: [
      httpLink<DashboardRouter>({
        url: `${options.baseUrl}/trpc`,
        methodOverride: 'POST',
        fetch: options.fetch,
        headers: () => {
          const token = options.tokenStore.get();
          return token ? { 'x-dashboard-token': token } : {};
        },
      }),
    ],
  });
}
