import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  newProjectThreadPath,
  useDashboardNavigate,
} from '../routes/navigation';
import { useDashboardSurfaces } from './dashboard-surface-context';
import styles from './new-thread-project-chooser.module.css';

export function NewThreadProjectChooser({
  snapshot,
}: {
  snapshot: BrowserSnapshot;
}) {
  const go = useDashboardNavigate();
  const surfaces = useDashboardSurfaces();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const projects = useMemo(
    () =>
      (snapshot.projects ?? []).filter(
        (project) => project.status === 'active',
      ),
    [snapshot.projects],
  );
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? projects.filter((project) =>
          `${project.title} ${project.rootPath}`
            .toLocaleLowerCase()
            .includes(needle),
        )
      : projects;
  }, [projects, query]);
  const [activeId, setActiveId] = useState<string>();
  const activeIndex = filtered.findIndex((project) => project.id === activeId);
  const resolvedActiveId = activeIndex >= 0 ? activeId : filtered[0]?.id;
  const resolvedActiveIndex = filtered.findIndex(
    (project) => project.id === resolvedActiveId,
  );
  const activeOptionId =
    resolvedActiveIndex < 0
      ? undefined
      : `${listId}-option-${resolvedActiveIndex}`;

  useEffect(() => {
    if (resolvedActiveId !== activeId) setActiveId(resolvedActiveId);
  }, [activeId, resolvedActiveId]);

  const choose = (projectId: string) => {
    surfaces?.close();
    go(newProjectThreadPath(snapshot, projectId));
  };
  const move = (direction: 1 | -1) => {
    if (!filtered.length) return;
    const index = Math.max(0, activeIndex);
    const next = Math.min(filtered.length - 1, Math.max(0, index + direction));
    setActiveId(filtered[next]?.id);
  };
  const clearQuery = () => {
    setQuery('');
    setActiveId(undefined);
    inputRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && query) {
      event.preventDefault();
      event.stopPropagation();
      clearQuery();
      return;
    }
    if (
      event.key === 'ArrowDown' ||
      (event.ctrlKey && event.key.toLocaleLowerCase() === 'j')
    ) {
      event.preventDefault();
      move(1);
      return;
    }
    if (
      event.key === 'ArrowUp' ||
      (event.ctrlKey && event.key.toLocaleLowerCase() === 'k')
    ) {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveId(event.key === 'Home' ? filtered[0]?.id : filtered.at(-1)?.id);
      return;
    }
    if (event.key === 'Enter' && resolvedActiveId) {
      event.preventDefault();
      choose(resolvedActiveId);
    }
  };

  return (
    <div className={styles.chooser}>
      <div className={styles.search}>
        <span aria-hidden="true">⌕</span>
        <input
          ref={inputRef}
          aria-activedescendant={activeOptionId}
          aria-controls={listId}
          aria-expanded="true"
          aria-label="Search projects"
          onChange={(event) => {
            setQuery(event.target.value.slice(0, 512));
            setActiveId(undefined);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search name or path"
          role="combobox"
          type="text"
          value={query}
        />
        {query && (
          <button
            type="button"
            aria-label="Clear project search"
            onClick={clearQuery}
          >
            ×
          </button>
        )}
      </div>
      <div
        className={`${styles.results} surface-scroll-region`}
        id={listId}
        role="listbox"
        aria-label="Projects"
      >
        {filtered.map((project, index) => {
          const active = project.id === resolvedActiveId;
          return (
            <button
              type="button"
              aria-selected={active}
              className={active ? styles.active : undefined}
              id={`${listId}-option-${index}`}
              key={project.id}
              onClick={() => choose(project.id)}
              onMouseMove={() => setActiveId(project.id)}
              role="option"
              tabIndex={-1}
            >
              <strong>{project.title}</strong>
              <small>{project.rootPath}</small>
            </button>
          );
        })}
        {!filtered.length && (
          <p className={styles.empty}>No matching projects.</p>
        )}
      </div>
      {!projects.length && (
        <button
          type="button"
          className={styles.register}
          onClick={() => {
            surfaces?.close();
            go('/projects');
          }}
        >
          Register a project
        </button>
      )}
      <footer className={styles.footer}>
        <span>↑↓ navigate</span>
        <span>Enter choose</span>
        <span>Esc clear / close</span>
      </footer>
    </div>
  );
}
