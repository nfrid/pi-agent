import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useRouterState } from '@tanstack/react-router';
import { useDashboardNavigate } from '../routes/navigation';
import { CommandPalette } from './command-palette';
import { PushButton } from './notifications';

export function runtimeStatusCounts(snapshot: BrowserSnapshot) {
  return {
    working: snapshot.runtimes.filter(
      (runtime) => runtime.online !== false && runtime.liveState === 'working',
    ).length,
    waiting: snapshot.runtimes.filter(
      (runtime) => runtime.online !== false && runtime.liveState === 'waiting',
    ).length,
    failed: snapshot.runtimes.filter(
      (runtime) => runtime.online !== false && runtime.liveState === 'failed',
    ).length,
    offline: snapshot.runtimes.filter((runtime) => runtime.online === false)
      .length,
  };
}

const destinations = [
  { path: '/', label: 'Agents', icon: '◈' },
  { path: '/workspaces', label: 'Workspaces', icon: '⌂' },
  { path: '/sessions', label: 'Sessions', icon: '▤' },
  { path: '/inbox', label: 'Inbox', icon: '✉' },
] as const;

function NavigationLinks({ snapshot }: { snapshot: BrowserSnapshot }) {
  const go = useDashboardNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const unreadCount = snapshot.unread.length;
  return (
    <nav className="primary-nav" aria-label="Primary navigation">
      {destinations.map((destination) => {
        const active =
          pathname === destination.path ||
          (destination.path !== '/' &&
            pathname.startsWith(`${destination.path}/`));
        return (
          <button
            type="button"
            className={`nav-item ${active ? 'active' : ''}`}
            aria-current={active ? 'page' : undefined}
            key={destination.path}
            onClick={() => go(destination.path)}
          >
            <span className="nav-icon" aria-hidden="true">
              {destination.icon}
            </span>
            <span>{destination.label}</span>
            {destination.label === 'Inbox' && unreadCount > 0 && (
              <span className="nav-badge">
                <span className="sr-only">{unreadCount} unread</span>
                <span aria-hidden="true">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

function StatusSummary({ snapshot }: { snapshot: BrowserSnapshot }) {
  const counts = runtimeStatusCounts(snapshot);
  return (
    <section className="rail-status" aria-label="Runtime status">
      <p className="rail-label">Runtime status</p>
      <div className="status-list">
        <span className="status-item working-glyph">
          <i aria-hidden="true">●</i> {counts.working} working
        </span>
        <span className="status-item waiting-glyph">
          <i aria-hidden="true">◆</i> {counts.waiting} waiting
        </span>
        {counts.failed > 0 && (
          <span className="status-item warning-text">
            <i aria-hidden="true">×</i> {counts.failed} failed
          </span>
        )}
        {counts.offline > 0 && (
          <span className="status-item">
            <i aria-hidden="true">○</i> {counts.offline} offline
          </span>
        )}
      </div>
    </section>
  );
}

function Brand() {
  const go = useDashboardNavigate();
  return (
    <button
      type="button"
      className="brand"
      onClick={() => go('/')}
      aria-label="Pi Dashboard home"
    >
      <span className="prompt">›</span> PI
      <span className="brand-slash">{'//'}</span>DASHBOARD
    </button>
  );
}

export function Header({ snapshot }: { snapshot: BrowserSnapshot }) {
  const go = useDashboardNavigate();
  return (
    <header className="navigation-shell">
      <aside className="side-rail" aria-label="Dashboard navigation">
        <Brand />
        <NavigationLinks snapshot={snapshot} />
        <StatusSummary snapshot={snapshot} />
        <div className="rail-actions">
          <button
            type="button"
            className="new-agent-button"
            onClick={() => go('/new')}
          >
            + Agent
          </button>
          <PushButton />
        </div>
      </aside>
      <div className="mobile-topbar">
        <Brand />
        <StatusSummary snapshot={snapshot} />
        <button
          type="button"
          className="new-agent-button"
          aria-label="New agent"
          onClick={() => go('/new')}
        >
          + Agent
        </button>
      </div>
      <div className="mobile-bottom-nav">
        <NavigationLinks snapshot={snapshot} />
      </div>
      <div className="global-tools">
        <CommandPalette snapshot={snapshot} />
      </div>
    </header>
  );
}
