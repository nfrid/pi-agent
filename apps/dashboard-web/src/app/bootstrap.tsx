import {
  dashboardHttpClient,
  snapshotQueryOptions,
  snapshotRequestGeneration,
  usageQueryOptions,
} from '@pi-dashboard/client';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useDashboardShell } from '../dashboard-transport';
import { dashboardRouterInstance } from '../routes/tree';
import { DashboardContext } from './dashboard-context';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

function AuthPrompt() {
  const [value, setValue] = useState('');
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    localStorage.setItem('pi-dashboard-token', value.trim());
    window.location.reload();
  };
  return (
    <main className="shell centered">
      <h1>Pi Dashboard</h1>
      <p>Enter the browser token printed by the dashboard daemon.</p>
      <form className="auth-form" onSubmit={save}>
        <input
          aria-label="Dashboard token"
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="current-password"
        />
        <AriaButton type="submit">Connect</AriaButton>
      </form>
    </main>
  );
}

export function DashboardBootstrap() {
  return (
    <QueryClientProvider client={queryClient}>
      <DashboardApp />
    </QueryClientProvider>
  );
}

function DashboardApp() {
  const dashboard = useDashboardShell();
  const snapshotQuery = useQuery(
    snapshotQueryOptions(dashboardHttpClient, () =>
      dashboard.store.getGeneration(),
    ),
  );
  const usageQuery = useQuery(usageQueryOptions(dashboardHttpClient));
  useEffect(() => {
    if (snapshotQuery.data) {
      const requestGeneration = snapshotRequestGeneration(snapshotQuery.data);
      if (requestGeneration !== undefined)
        dashboard.store.installSnapshot(snapshotQuery.data, {
          source: 'http',
          requestGeneration,
        });
    }
    if (snapshotQuery.error)
      dashboard.store.setError(
        snapshotQuery.error instanceof Error
          ? snapshotQuery.error.message
          : String(snapshotQuery.error),
      );
  }, [dashboard.store, snapshotQuery.data, snapshotQuery.error]);
  useEffect(() => {
    if (usageQuery.data?.usage !== undefined)
      dashboard.store.updateUsage(usageQuery.data.usage);
    if (usageQuery.data?.error)
      dashboard.store.setUsageError(usageQuery.data.error);
  }, [dashboard.store, usageQuery.data]);
  if (
    !dashboard.snapshot &&
    snapshotQuery.error instanceof Error &&
    snapshotQuery.error.message.includes('Authentication')
  )
    return <AuthPrompt />;
  if (!dashboard.snapshot)
    return (
      <main className="shell centered">
        <h1>Pi Dashboard</h1>
        <p className="error">{dashboard.error ?? 'Connecting…'}</p>
        <button type="button" onClick={() => void snapshotQuery.refetch()}>
          Retry
        </button>
      </main>
    );
  return (
    <DashboardContext.Provider value={dashboard}>
      <RouterProvider router={dashboardRouterInstance} />
    </DashboardContext.Provider>
  );
}
