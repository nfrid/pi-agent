import type { DashboardRouter } from '@pi-dashboard/server/trpc';
import {
  createTRPCClient,
  httpLink,
  httpSubscriptionLink,
  splitLink,
  type TRPCClient,
} from '@trpc/client';
import { EventSource } from 'eventsource';
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
export type DashboardTrpcClient = TRPCClient<DashboardRouter>;

export function createDashboardTrpcClient(
  options: DashboardTrpcClientOptions,
): DashboardTrpcClient {
  const url = `${options.baseUrl}/trpc`;
  const headers = () => {
    const token = options.tokenStore.get();
    return token ? { 'x-dashboard-token': token } : {};
  };
  const finiteLink = httpLink<DashboardRouter>({
    url,
    methodOverride: 'POST',
    // tRPC's undefined input normally produces an empty POST body. The
    // dashboard adapter deliberately normalizes that to JSON null because
    // Fastify's JSON parser and the protocol contract both expect JSON.
    fetch: (input, init) =>
      options.fetch(
        input,
        init?.method === 'POST' && init.body == null
          ? { ...init, body: 'null' }
          : init,
      ),
    headers,
  });
  const subscriptionLink = httpSubscriptionLink({
    url,
    EventSource,
    eventSourceOptions: {
      // eventsource@5 uses fetch rather than a URL query/header shim. Keep the
      // token in this per-request header callback; it never enters tRPC input,
      // the URL, or a tracked event ID.
      fetch: (input, init) => {
        const requestHeaders = new Headers(init?.headers);
        const token = options.tokenStore.get();
        if (token) requestHeaders.set('x-dashboard-token', token);
        return options.fetch(input, { ...init, headers: requestHeaders });
      },
    },
  });
  return createTRPCClient<DashboardRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: subscriptionLink,
        false: finiteLink,
      }),
    ],
  });
}
