import {
  dashboardHttpClient,
  usageQueryOptions,
  useDashboardShell,
} from '@pi-dashboard/client';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { reloadDashboard } from '../pwa-update';
import { dashboardRouterInstance } from '../routes/tree';
import { DashboardContext } from './dashboard-context';

export const dashboardQueryClient = new QueryClient({
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
    <QueryClientProvider client={dashboardQueryClient}>
      <DashboardApp />
    </QueryClientProvider>
  );
}

function ReloadRequiredState() {
  return (
    <main className="shell centered">
      <div role="alert" aria-live="assertive">
        <h1>Dashboard update required</h1>
        <p>
          This dashboard is out of date. Reload to connect to the current
          server.
        </p>
        <button type="button" onClick={() => void reloadDashboard()}>
          Reload to update
        </button>
      </div>
    </main>
  );
}

function DashboardApp() {
  const dashboard = useDashboardShell();
  const usageQuery = useQuery(usageQueryOptions(dashboardHttpClient));
  useEffect(() => {
    if (usageQuery.data?.usage !== undefined)
      dashboard.store.updateUsage(usageQuery.data.usage);
    if (usageQuery.data?.error)
      dashboard.store.setUsageError(usageQuery.data.error);
  }, [dashboard.store, usageQuery.data]);
  const startupErrorKind = dashboard.errorKind;
  if (!dashboard.snapshot && startupErrorKind === 'protocol-mismatch')
    return <ReloadRequiredState />;
  if (!dashboard.snapshot && startupErrorKind === 'authentication')
    return <AuthPrompt />;
  if (!dashboard.snapshot)
    return (
      <main className="shell centered">
        <h1>Pi Dashboard</h1>
        <p className="error">{dashboard.error ?? 'Connecting…'}</p>
        <button type="button" onClick={() => dashboard.store.reconnect()}>
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
