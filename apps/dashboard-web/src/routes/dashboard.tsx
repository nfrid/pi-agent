import {
  type DashboardLiveStore,
  dashboardHttpClient,
  workspaceRefreshMutationOptions,
} from '@pi-dashboard/client';
import {
  isActionAvailable,
  type RuntimeCapabilitySnapshot,
} from '@pi-dashboard/extension-contributions';
import type {
  BrowserSnapshot,
  RuntimeSnapshot,
  SessionIndexEntry,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { workspaceForPath } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { sessionDisplayTitle } from '../app-helpers';
import {
  NotificationList,
  PushButton,
  UsagePanel,
} from '../features/notifications';

function useDashboardNavigate(): (path: string) => void {
  const navigate = useNavigate();
  return (path) => void navigate({ to: path });
}

export function Header({ snapshot }: { snapshot: BrowserSnapshot }) {
  const go = useDashboardNavigate();
  const working = snapshot.runtimes.filter(
    (runtime) => runtime.online !== false && runtime.liveState === 'working',
  ).length;
  const waiting = snapshot.runtimes.filter(
    (runtime) => runtime.online !== false && runtime.liveState === 'waiting',
  ).length;
  const online = snapshot.runtimes.filter(
    (runtime) => runtime.online !== false,
  ).length;
  return (
    <header className="topbar">
      <div className="rail-inner">
        <button
          type="button"
          className="brand"
          onClick={() => go('/')}
          aria-label="Pi Dashboard home"
        >
          <span className="prompt">›</span> PI
          <span className="brand-slash">{'//'}</span>DASHBOARD
        </button>
        <div className="header-status">
          <span className="header-stat">
            <i className="status-glyph working-glyph">●</i>
            {working} working
          </span>
          <span className="header-stat warning-text">
            <i className="status-glyph waiting-glyph">◆</i>
            {waiting} waiting
          </span>
          <span className="header-stat muted-stat">{online} online</span>
        </div>
        <PushButton />
        <CommandPalette snapshot={snapshot} />
        <button
          type="button"
          className="header-action"
          onClick={() => go('/new')}
        >
          + Agent
        </button>
      </div>
    </header>
  );
}

export function actionNeedsInput(action: { inputSchema?: unknown }): boolean {
  const schema = action.inputSchema;
  // Older manifests omitted inputSchema for actions that accept {}. Treat an
  // absent schema, and an explicitly empty object schema, as inputless.
  if (schema === undefined || schema === null) return false;
  if (typeof schema !== 'object' || Array.isArray(schema)) return true;
  const value = schema as { required?: unknown; minProperties?: unknown };
  return (
    (Array.isArray(value.required) && value.required.length > 0) ||
    (typeof value.minProperties === 'number' && value.minProperties > 0)
  );
}

type PaletteItem =
  | {
      kind: 'navigate';
      id: string;
      title: string;
      description: string;
      path: string;
    }
  | {
      kind: 'action';
      id: string;
      title: string;
      description: string;
      runtime: RuntimeSnapshot;
      action: ReturnType<typeof snapshotActions>[number]['action'];
      target: string;
      needsInput: boolean;
    };

// Keep the palette useful on large installations without creating a second
// unbounded session browser inside the dialog.
const MAX_PALETTE_WORKSPACES = 24;
const MAX_PALETTE_SESSIONS = 24;

function snapshotActions(snapshot: BrowserSnapshot) {
  return snapshot.runtimes.flatMap((runtime) =>
    runtime.online === false
      ? []
      : (runtime.capabilities?.manifests ?? []).flatMap((manifest) =>
          manifest.actions
            .filter((action) =>
              isActionAvailable(
                action,
                runtime.capabilities as RuntimeCapabilitySnapshot | undefined,
                {
                  online: runtime.online !== false,
                  liveState: runtime.liveState,
                  pendingInteractions: runtime.pendingInteractions.length,
                },
              ),
            )
            .map((action) => ({ runtime, action })),
        ),
  );
}

export function paletteItems(snapshot: BrowserSnapshot): PaletteItem[] {
  const primary: PaletteItem[] = [
    {
      kind: 'navigate',
      id: 'dashboard',
      title: 'Dashboard',
      description: 'Go to the operational overview',
      path: '/',
    },
    {
      kind: 'navigate',
      id: 'new-agent',
      title: 'New Agent',
      description: 'Start an agent in a workspace',
      path: '/new',
    },
  ];
  const actions = snapshotActions(snapshot).map(
    ({ runtime, action }): PaletteItem => ({
      kind: 'action',
      id: `action:${runtime.runtimeId}:${action.id}`,
      title: action.title ?? action.id,
      description: action.description ?? action.id,
      runtime,
      action,
      target: sessionDisplayTitle(runtime.session, runtime.session.entries),
      needsInput: actionNeedsInput(action),
    }),
  );
  const sessions = snapshot.sessions.slice(0, MAX_PALETTE_SESSIONS).map(
    (session): PaletteItem => ({
      kind: 'navigate',
      id: `session:${session.id}`,
      title: `Session: ${sessionDisplayTitle(session)}`,
      description: session.cwd,
      path: `/sessions/${encodeURIComponent(session.id)}`,
    }),
  );
  const workspaces = snapshot.workspaces.slice(0, MAX_PALETTE_WORKSPACES).map(
    (workspace): PaletteItem => ({
      kind: 'navigate',
      id: `workspace:${workspace.id}`,
      title: `Workspace: ${workspace.name}`,
      description: workspace.canonicalPath,
      path: `/workspaces/${encodeURIComponent(workspace.id)}`,
    }),
  );
  return [...primary, ...actions, ...sessions, ...workspaces];
}

function CommandPalette({ snapshot }: { snapshot: BrowserSnapshot }) {
  const go = useDashboardNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  const items = paletteItems(snapshot);
  const runtimeActionCount = items.filter(
    (item) => item.kind === 'action',
  ).length;
  const filtered = items.filter((item) =>
    `${item.title} ${item.description} ${
      item.kind === 'action'
        ? `${item.target} ${item.runtime.cwd} ${item.runtime.runtimeId}`
        : ''
    }`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const enabledIndexes = filtered.flatMap((item, index) =>
    item.kind === 'navigate' || !item.needsInput ? [index] : [],
  );
  const firstEnabledIndex = enabledIndexes[0] ?? 0;
  const selectionResetKey = `${query}\u0000${enabledIndexes.join(',')}`;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) triggerRef.current?.focus();
      wasOpenRef.current = false;
      return;
    }
    wasOpenRef.current = true;
    setError(undefined);
    setQuery('');
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);
  useEffect(() => {
    // The derived key also changes when a query changes but results do not.
    void selectionResetKey;
    setSelected(firstEnabledIndex);
  }, [selectionResetKey, firstEnabledIndex]);
  const close = () => setOpen(false);
  const moveSelection = (direction: 1 | -1) => {
    if (!enabledIndexes.length) return;
    const currentPosition = enabledIndexes.indexOf(selected);
    const nextPosition =
      currentPosition < 0
        ? 0
        : (currentPosition + direction + enabledIndexes.length) %
          enabledIndexes.length;
    setSelected(enabledIndexes[nextPosition] ?? 0);
  };
  const invoke = async (index: number) => {
    const item = filtered[index];
    if (!item || (item.kind === 'action' && item.needsInput)) return;
    setError(undefined);
    if (item.kind === 'navigate') {
      close();
      go(item.path);
      return;
    }
    try {
      await dashboardHttpClient.invokeAction(
        item.runtime.runtimeId,
        item.action.id,
        {},
      );
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="header-action palette-trigger"
        aria-label="Open command palette"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Ctrl/⌘ K
      </button>
      {open && (
        // The backdrop intentionally closes on a click outside the dialog.
        // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is an inert click target, not a content element.
        <div
          className="palette-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            ref={dialogRef}
            className="command-palette"
            role="dialog"
            aria-modal="true"
            aria-labelledby="command-palette-heading"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
                return;
              }
              if (event.key !== 'Tab') return;
              const focusable = Array.from(
                dialogRef.current?.querySelectorAll<HTMLElement>(
                  'input, button:not(:disabled)',
                ) ?? [],
              );
              const first = focusable[0];
              const last = focusable.at(-1);
              if (!first || !last) return;
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="command-palette-heading">Command palette</h2>
            <input
              ref={inputRef}
              aria-label="Filter actions and navigation"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  moveSelection(1);
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  moveSelection(-1);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  void invoke(selected);
                }
              }}
              placeholder="Search actions, sessions, and workspaces…"
            />
            <div
              className="palette-list"
              role="listbox"
              aria-label="Commands and navigation"
            >
              {filtered.map((item, index) => {
                const disabled = item.kind === 'action' && item.needsInput;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected === index}
                    className={selected === index ? 'palette-selected' : ''}
                    disabled={disabled}
                    key={item.id}
                    onClick={() => void invoke(index)}
                  >
                    <strong>{item.title}</strong>
                    <small>
                      {item.kind === 'action' && disabled
                        ? `Requires input — open the session to complete it. ${item.description}`
                        : item.description}
                    </small>
                    {item.kind === 'action' && (
                      <small className="palette-target">
                        Target: {item.runtime.runtimeId} · {item.target} ·{' '}
                        {item.runtime.cwd}
                      </small>
                    )}
                  </button>
                );
              })}
              {!filtered.length && query.trim() && (
                <p className="empty">No results for “{query.trim()}”.</p>
              )}
              {!query.trim() && runtimeActionCount === 0 && (
                <p className="palette-runtime-empty">
                  No actions available from connected runtimes. Navigation is
                  still available above.
                </p>
              )}
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <p className="muted">Esc close · ↑↓ move · Enter run</p>
          </section>
        </div>
      )}
    </>
  );
}

function WorkspaceRefresh({
  snapshot,
  store,
}: {
  snapshot: BrowserSnapshot;
  store?: DashboardLiveStore;
}) {
  const mutation = useMutation(
    workspaceRefreshMutationOptions(dashboardHttpClient),
  );
  const refresh = async () => {
    try {
      const result = (await mutation.mutateAsync()) as {
        workspaces?: BrowserSnapshot['workspaces'];
      };
      if (store && result.workspaces) {
        store.installSnapshot(
          { ...snapshot, workspaces: result.workspaces },
          { source: 'http', requestGeneration: store.getGeneration() },
        );
      }
    } catch {
      // The live catalogue remains usable; the button exposes failure state.
    }
  };
  return (
    <button
      type="button"
      className="header-action"
      onClick={() => void refresh()}
      disabled={mutation.isPending}
      aria-label="Refresh workspaces"
    >
      {mutation.isPending ? 'Refreshing…' : 'Refresh workspaces'}
    </button>
  );
}

export function Dashboard({
  snapshot,
  usageError,
  store,
}: {
  snapshot: BrowserSnapshot;
  usageError?: string;
  store?: DashboardLiveStore;
}) {
  const go = useDashboardNavigate();
  const groups = new Map<
    string,
    { workspace: WorkspaceTarget | undefined; runtimes: RuntimeSnapshot[] }
  >();
  for (const workspace of snapshot.workspaces)
    groups.set(workspace.id, { workspace, runtimes: [] });
  for (const runtime of snapshot.runtimes) {
    const workspace = workspaceForPath(runtime.cwd, snapshot.workspaces);
    const key = workspace?.id ?? 'other';
    groups.set(key, groups.get(key) ?? { workspace, runtimes: [] });
    groups.get(key)?.runtimes.push(runtime);
  }
  const orderedGroups = [...groups.entries()]
    .filter(([, group]) => group.runtimes.length > 0 || group.workspace?.active)
    .sort(([, a], [, b]) => {
      const active = (group: typeof a) =>
        group.runtimes.some(
          (runtime) => runtime.online !== false && runtime.liveState !== 'idle',
        );
      return Number(active(b)) - Number(active(a));
    });
  const liveCount = snapshot.runtimes.filter(
    (runtime) => runtime.online !== false,
  ).length;
  return (
    <section>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Operational view</p>
          <h1>Agents</h1>
        </div>
        <div className="section-heading-actions">
          <span className="muted">
            {liveCount
              ? `${liveCount} live runtime${liveCount === 1 ? '' : 's'}`
              : 'No live runtimes'}{' '}
            · {snapshot.runtimes.length} tracked · {snapshot.sessions.length}{' '}
            sessions
          </span>
          <WorkspaceRefresh snapshot={snapshot} store={store} />
        </div>
      </div>
      {liveCount === 0 && (
        <div className="empty-hero">
          <span className="empty-mark">›_</span>
          <div>
            <strong>
              {snapshot.runtimes.length
                ? 'No runtimes are connected.'
                : 'Nothing is running yet.'}
            </strong>
            <p>
              {snapshot.runtimes.length
                ? 'Offline and failed runtimes remain below for diagnosis.'
                : 'Start an agent to see its work here, or open a workspace through Sesh.'}
            </p>
          </div>
          <button type="button" onClick={() => go('/new')}>
            Start an agent
          </button>
        </div>
      )}
      {orderedGroups.map(([key, group]) => (
        <div
          className={`workspace-block ${group.runtimes.length ? '' : 'workspace-empty'}`}
          key={key}
        >
          <div className="workspace-title">
            <button
              type="button"
              onClick={() =>
                group.workspace && go(`/workspaces/${group.workspace.id}`)
              }
            >
              {group.workspace?.name ?? 'Other runtimes'}
            </button>
            <span>
              {group.runtimes.length
                ? `${group.runtimes.length} runtime${group.runtimes.length === 1 ? '' : 's'}`
                : group.workspace?.active
                  ? 'ready'
                  : 'dormant'}
            </span>
          </div>
          {group.runtimes.length ? (
            group.runtimes.map((runtime) => (
              <RuntimeCard key={runtime.runtimeId} runtime={runtime} />
            ))
          ) : (
            <p className="empty">
              {group.workspace?.active
                ? 'Ready for a new runtime.'
                : 'Open through Sesh to activate this workspace.'}
            </p>
          )}
        </div>
      ))}
      {groups.size === 0 && (
        <p className="empty">No Sesh workspaces discovered.</p>
      )}
      {snapshot.unread.length > 0 && (
        <NotificationList notifications={snapshot.unread} />
      )}
      <UsagePanel usage={snapshot.usage} error={usageError} />
      {snapshot.sessions.length > 0 && (
        <div className="recent-sessions">
          <div className="workspace-title">
            <span>Recent sessions</span>
            <span>across all workspaces</span>
          </div>
          {snapshot.sessions.slice(0, 8).map((session) => (
            <SessionRow key={session.id} session={session} />
          ))}
        </div>
      )}
    </section>
  );
}

function RuntimeCard({ runtime }: { runtime: RuntimeSnapshot }) {
  const go = useDashboardNavigate();
  const status = runtime.online === false ? 'offline' : runtime.liveState;
  const title = sessionDisplayTitle(runtime.session, runtime.session.entries);
  const glyph =
    status === 'working'
      ? '●'
      : status === 'waiting'
        ? '◆'
        : status === 'failed'
          ? '×'
          : status === 'offline'
            ? '○'
            : '·';
  const model = runtime.model
    ? `${runtime.model.provider}/${runtime.model.model}`
    : 'model unavailable';
  return (
    <button
      type="button"
      className={`runtime-card ${status}`}
      aria-label={`${title} ${status}`}
      onClick={() => go(`/sessions/${encodeURIComponent(runtime.session.id)}`)}
    >
      <span className="runtime-rail">
        <span className="status-glyph">{glyph}</span>
      </span>
      <span className="runtime-main">
        <strong>{title}</strong>
        <span>
          <b>{status}</b> · {model}
        </span>
        <small>
          {runtime.lastError ?? `${runtime.cwd} · ${runtime.ownership}`}
        </small>
      </span>
      <span className="runtime-owner">
        {runtime.tmux?.displayTarget ?? 'session'}
      </span>
    </button>
  );
}

export function WorkspaceView({
  id,
  snapshot,
}: {
  id: string;
  snapshot: BrowserSnapshot;
}) {
  const go = useDashboardNavigate();
  const workspace = snapshot.workspaces.find((item) => item.id === id);
  const runtimes = snapshot.runtimes.filter(
    (runtime) =>
      workspace &&
      (runtime.cwd === workspace.canonicalPath ||
        runtime.cwd.startsWith(`${workspace.canonicalPath}/`)),
  );
  const sessions = snapshot.sessions.filter(
    (session) => session.workspaceId === id,
  );
  return (
    <section>
      <Back />
      <div className="section-heading">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>{workspace?.name ?? 'Unknown workspace'}</h1>
          <p className="muted path">{workspace?.canonicalPath}</p>
        </div>
        <button type="button" onClick={() => go('/new')}>
          Start agent
        </button>
      </div>
      {workspace && !workspace.active && (
        <div className="notice">
          This workspace has no active tmux session yet. Open it through Sesh on
          the Mac first.
        </div>
      )}
      <h2>Active runtimes</h2>
      {runtimes.map((runtime) => (
        <RuntimeCard runtime={runtime} key={runtime.runtimeId} />
      ))}
      {!runtimes.length && <p className="empty">No active runtimes.</p>}
      <h2>Recent sessions</h2>
      {sessions.map((session) => (
        <SessionRow key={session.id} session={session} />
      ))}
    </section>
  );
}

function SessionRow({ session }: { session: SessionIndexEntry }) {
  const go = useDashboardNavigate();
  return (
    <button
      type="button"
      className="session-row"
      onClick={() => go(`/sessions/${encodeURIComponent(session.id)}`)}
    >
      <span>
        <strong>{sessionDisplayTitle(session)}</strong>
        <small>{session.cwd}</small>
      </span>
      <span className="muted">
        {new Date(session.updatedAt).toLocaleDateString()}
      </span>
    </button>
  );
}
export function Back() {
  const go = useDashboardNavigate();
  return (
    <button type="button" className="back" onClick={() => go('/')}>
      ← Dashboard
    </button>
  );
}
