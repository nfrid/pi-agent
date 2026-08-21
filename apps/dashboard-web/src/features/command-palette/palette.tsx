import { dashboardHttpClient } from '@pi-dashboard/client';
import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useEffect, useRef, useState } from 'react';
import { useDashboardNavigate } from '../../routes/navigation';
import { errorMessage } from '../../shared/lib/error-message';
import { useDashboardUtility } from '../dashboard-utility-context';
import {
  DASHBOARD_MOTION_MS,
  useOverlayFocusRestore,
  useOverlayPresence,
} from '../overlay-presence';
import { paletteItems } from './items';

export function CommandPalette({
  snapshot,
  disabled = false,
}: {
  snapshot: BrowserSnapshot;
  disabled?: boolean;
}) {
  const go = useDashboardNavigate();
  const utility = useDashboardUtility();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string>();
  const { present: palettePresent, exiting: paletteExiting } =
    useOverlayPresence(open);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { rememberFocus } = useOverlayFocusRestore(open);
  const utilityTimerRef = useRef<number | undefined>(undefined);
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
        if (disabled) return;
        setOpen((value) => {
          if (!value) rememberFocus();
          return !value;
        });
      }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [disabled, rememberFocus]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(
    () => () => {
      if (utilityTimerRef.current !== undefined)
        window.clearTimeout(utilityTimerRef.current);
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
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
      const utilityPanel =
        item.path === '/workspaces'
          ? 'workspaces'
          : item.path === '/sessions'
            ? 'sessions'
            : item.path === '/inbox'
              ? 'inbox'
              : undefined;
      close();
      if (utility && utilityPanel) {
        if (utilityTimerRef.current !== undefined)
          window.clearTimeout(utilityTimerRef.current);
        const pathname = window.location.pathname;
        utilityTimerRef.current = window.setTimeout(() => {
          utilityTimerRef.current = undefined;
          if (window.location.pathname === pathname)
            utility.openPanel(utilityPanel);
        }, DASHBOARD_MOTION_MS);
      } else go(item.path);
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
      setError(errorMessage(cause));
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
        disabled={disabled}
        onClick={() =>
          setOpen((value) => {
            if (!value) rememberFocus();
            return !value;
          })
        }
      >
        Ctrl/⌘ K
      </button>
      {palettePresent && (
        // The backdrop intentionally closes on a click outside the dialog.
        <div
          className={`palette-backdrop${paletteExiting ? ' is-exiting' : ''}`}
          aria-hidden={paletteExiting || undefined}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            ref={dialogRef}
            className={`command-palette${paletteExiting ? ' is-exiting' : ''}`}
            role="dialog"
            aria-hidden={paletteExiting || undefined}
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
