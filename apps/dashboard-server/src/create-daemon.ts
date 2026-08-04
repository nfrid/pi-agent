import {
  type DashboardServer,
  DashboardServerImpl,
  type DashboardServerOptions,
} from './http.js';

/** Manual composition root retained separately from the HTTP transport. */
export async function createDaemon(
  options: DashboardServerOptions = {},
): Promise<DashboardServer> {
  return new DashboardServerImpl(options);
}
