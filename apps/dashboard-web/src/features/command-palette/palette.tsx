import { dashboardHttpClient } from '@pi-dashboard/client';
import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useDashboardNavigate } from '../../routes/navigation';
import { errorMessage } from '../../shared/lib/error-message';
import { useDashboardSurfaces } from '../dashboard-surface-context';
import {
  type PaletteGroup,
  type PaletteMatchRange,
  type PaletteSearchResult,
  paletteItems,
  searchPaletteItems,
} from './items';

const GROUP_ORDER: readonly PaletteGroup[] = [
  'Actions',
  'Navigation',
  'Threads',
  'Projects',
];
const PAGE_STEP = 6;

function isPaletteShortcut(event: globalThis.KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLocaleLowerCase() === 'k'
  );
}

export function CommandPaletteTrigger({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const surfaces = useDashboardSurfaces();
  const paletteOpen = surfaces?.stack.at(-1)?.type === 'command-palette';
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      if (
        event.ctrlKey &&
        !event.metaKey &&
        surfaces?.stack.at(-1)?.type === 'new-thread-project'
      )
        return;
      event.preventDefault();
      if (disabled || !surfaces) return;
      if (surfaces.stack.at(-1)?.type === 'command-palette') surfaces.close();
      else surfaces.replace({ type: 'command-palette' });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [disabled, surfaces]);
  return (
    <button
      type="button"
      className="header-action palette-trigger"
      aria-label="Open command palette"
      aria-expanded={paletteOpen}
      disabled={disabled}
      onClick={() => {
        if (!surfaces) return;
        if (paletteOpen) surfaces.close();
        else surfaces.replace({ type: 'command-palette' });
      }}
    >
      Ctrl/⌘ K
    </button>
  );
}

function mergeRanges(
  ranges: readonly PaletteMatchRange[] | undefined,
): PaletteMatchRange[] {
  if (!ranges?.length) return [];
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: PaletteMatchRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range[0] > previous[1] + 1) {
      merged.push(range);
      continue;
    }
    merged[merged.length - 1] = [previous[0], Math.max(previous[1], range[1])];
  }
  return merged;
}

export function HighlightedPaletteText({
  text,
  ranges,
}: {
  text: string;
  ranges?: readonly PaletteMatchRange[];
}) {
  const merged = mergeRanges(ranges);
  if (!merged.length) return text;
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) content.push(text.slice(cursor, start));
    content.push(
      <mark key={`${start}:${end}`}>{text.slice(start, end + 1)}</mark>,
    );
    cursor = end + 1;
  }
  if (cursor < text.length) content.push(text.slice(cursor));
  return content;
}

function groupedResults(results: readonly PaletteSearchResult[]) {
  return GROUP_ORDER.flatMap((group) => {
    const items = results.filter((result) => result.item.group === group);
    return items.length ? [{ group, items }] : [];
  });
}

function isEnabled(result: PaletteSearchResult): boolean {
  return result.item.kind !== 'action' || !result.item.needsInput;
}

export function CommandPalette({ snapshot }: { snapshot: BrowserSnapshot }) {
  const go = useDashboardNavigate();
  const surfaces = useDashboardSurfaces();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string>();
  const [error, setError] = useState<string>();
  const items = useMemo(() => paletteItems(snapshot), [snapshot]);
  const results = useMemo(
    () => searchPaletteItems(items, query),
    [items, query],
  );
  const enabledResults = results.filter(isEnabled);
  const resolvedActiveId = enabledResults.some(
    (result) => result.item.id === activeId,
  )
    ? activeId
    : enabledResults[0]?.item.id;
  const activeIndex = enabledResults.findIndex(
    (result) => result.item.id === resolvedActiveId,
  );
  const groups = groupedResults(results);
  const activeResultIndex = results.findIndex(
    (result) => result.item.id === resolvedActiveId,
  );
  const activeOptionId =
    activeResultIndex < 0 ? undefined : `${listId}-option-${activeResultIndex}`;

  useEffect(() => {
    if (resolvedActiveId !== activeId) setActiveId(resolvedActiveId);
  }, [activeId, resolvedActiveId]);
  useEffect(() => {
    if (!activeOptionId) return;
    document
      .getElementById(activeOptionId)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeOptionId]);

  const move = (offset: number) => {
    if (!enabledResults.length) return;
    const next = Math.min(
      enabledResults.length - 1,
      Math.max(0, Math.max(0, activeIndex) + offset),
    );
    setActiveId(enabledResults[next]?.item.id);
  };
  const invoke = async (result: PaletteSearchResult | undefined) => {
    if (!result || !isEnabled(result)) return;
    setError(undefined);
    const { item } = result;
    if (item.kind === 'navigate') {
      surfaces?.close();
      go(item.path);
      return;
    }
    if (item.kind === 'surface') {
      surfaces?.replace({ type: item.surface });
      return;
    }
    try {
      await dashboardHttpClient.invokeAction(
        item.runtime.runtimeId,
        item.action.id,
        {},
      );
      surfaces?.close();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      move(PAGE_STEP);
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      move(-PAGE_STEP);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveId(enabledResults[0]?.item.id);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveId(enabledResults.at(-1)?.item.id);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void invoke(enabledResults[activeIndex]);
    }
  };

  return (
    <div className="command-palette">
      <div className="palette-search">
        <span aria-hidden="true">⌕</span>
        <input
          ref={inputRef}
          aria-activedescendant={activeOptionId}
          aria-controls={listId}
          aria-expanded="true"
          aria-label="Search commands, threads, and projects"
          onChange={(event) => {
            setQuery(event.target.value.slice(0, 512));
            setActiveId(undefined);
            setError(undefined);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search commands, threads, and projects…"
          role="combobox"
          type="search"
          value={query}
        />
        {query && (
          <button
            type="button"
            aria-label="Clear command palette search"
            onClick={() => {
              setQuery('');
              setActiveId(undefined);
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        )}
      </div>
      <div
        className="palette-list surface-scroll-region"
        id={listId}
        role="listbox"
        aria-label="Commands and navigation"
      >
        {groups.map(({ group, items: groupItems }) => {
          return (
            <fieldset className="palette-group" key={group}>
              <legend>{group}</legend>
              {groupItems.map((result) => {
                const index = results.indexOf(result);
                const { item, matches } = result;
                const active = item.id === resolvedActiveId;
                const disabled = !isEnabled(result);
                return (
                  <button
                    type="button"
                    aria-disabled={disabled || undefined}
                    aria-selected={active}
                    className={active ? 'palette-selected' : undefined}
                    id={`${listId}-option-${index}`}
                    key={item.id}
                    onClick={() => void invoke(result)}
                    onMouseMove={() => {
                      if (!disabled) setActiveId(item.id);
                    }}
                    role="option"
                    tabIndex={-1}
                  >
                    <span className="palette-item-icon" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span className="palette-item-copy">
                      <strong>
                        <HighlightedPaletteText
                          text={item.title}
                          ranges={matches.title}
                        />
                      </strong>
                      <small>
                        {disabled ? 'Requires additional input · ' : ''}
                        <HighlightedPaletteText
                          text={item.description}
                          ranges={matches.description}
                        />
                      </small>
                      {item.meta && (
                        <small className="palette-item-meta">
                          <HighlightedPaletteText
                            text={item.meta}
                            ranges={matches.meta}
                          />
                        </small>
                      )}
                    </span>
                    {active && !disabled && (
                      <kbd className="palette-item-shortcut">↵</kbd>
                    )}
                  </button>
                );
              })}
            </fieldset>
          );
        })}
        {!results.length && query.trim() && (
          <p className="palette-empty">No results for "{query.trim()}".</p>
        )}
      </div>
      {error && (
        <p className="error palette-error" role="alert">
          {error}
        </p>
      )}
      <footer className="palette-footer">
        <span>↑↓ navigate</span>
        <span>Enter run</span>
        <span>Esc close</span>
        <span>&gt; actions only</span>
      </footer>
    </div>
  );
}
