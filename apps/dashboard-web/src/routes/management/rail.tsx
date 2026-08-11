import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useState } from 'react';
import { useDashboardNavigate } from '../navigation';
import { runningRunStatuses, threadNeedsAttention } from './projection';

function Rail({
  snapshot,
  activeProjectId,
}: {
  snapshot: BrowserSnapshot;
  activeProjectId?: string;
}) {
  const go = useDashboardNavigate();
  const [open, setOpen] = useState(false);
  const projects = snapshot.projects ?? [];
  const active = (snapshot.runs ?? []).filter((run) =>
    runningRunStatuses.has(run.status),
  ).length;
  const attention = (snapshot.threads ?? []).filter((thread) =>
    threadNeedsAttention(thread, snapshot.runs ?? []),
  ).length;
  return (
    <>
      <button
        type="button"
        className="management-drawer-toggle"
        aria-label="Open project rail"
        onClick={() => setOpen(true)}
      >
        ☰ Projects
      </button>
      <aside
        className={`project-rail ${open ? 'is-open' : ''}`}
        aria-label="Projects"
      >
        <div className="project-rail-heading">
          <strong>Projects</strong>
          <button
            type="button"
            aria-label="Close project rail"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
        <button
          type="button"
          className="rail-attention"
          onClick={() => {
            const scroll = () =>
              document
                .getElementById('global-needs-attention')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            if (window.location.pathname === '/') scroll();
            else {
              go('/');
              window.setTimeout(scroll, 0);
            }
          }}
        >
          <span>Needs attention</span>
          <b>{attention}</b>
        </button>
        <p className="rail-counts">
          {active} active ·{' '}
          {
            (snapshot.runs ?? []).filter((run) => run.status === 'queued')
              .length
          }{' '}
          queued
        </p>
        {projects.map((project) => (
          <button
            type="button"
            key={project.id}
            className={`project-rail-item ${project.id === activeProjectId ? 'active' : ''}`}
            onClick={() => {
              setOpen(false);
              go(`/projects/${encodeURIComponent(project.id)}`);
            }}
          >
            <span>{project.title}</span>
            <small>
              {
                (snapshot.runs ?? []).filter(
                  (run) =>
                    runningRunStatuses.has(run.status) &&
                    snapshot.threads?.find(
                      (thread) => thread.id === run.threadId,
                    )?.projectId === project.id,
                ).length
              }
              /{project.maxParallelRuns}
            </small>
          </button>
        ))}
        <button
          type="button"
          className="project-rail-new"
          onClick={() => {
            setOpen(false);
            go('/projects');
          }}
        >
          + Adopt project
        </button>
      </aside>
      {open && (
        <button
          type="button"
          className="project-rail-backdrop"
          aria-label="Close project rail"
          onClick={() => setOpen(false)}
        />
      )}
    </>
  );
}

export { Rail };
