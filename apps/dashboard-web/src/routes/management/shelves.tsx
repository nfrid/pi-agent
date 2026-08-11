import type { BrowserSnapshot, ProjectSummary } from '@pi-dashboard/protocol';
import { groupThreads, type ThreadShelf } from './projection';
import { ThreadCard } from './thread-card';

export function ProjectShelves({
  project,
  snapshot,
}: {
  project: ProjectSummary;
  snapshot: BrowserSnapshot;
}) {
  const threads = (snapshot.threads ?? []).filter(
    (thread) => thread.projectId === project.id,
  );
  const runs = snapshot.runs ?? [];
  const checkouts = snapshot.checkouts ?? [];
  const shelves = groupThreads(threads, runs);
  const labels: Record<ThreadShelf, string> = {
    pinned: 'Pinned',
    attention: 'Needs attention',
    running: 'Running',
    queued: 'Queued',
    recent: 'Recent',
    archived: 'Archived',
  };
  return (
    <div className="management-shelves">
      {(Object.keys(labels) as ThreadShelf[]).map((shelf) => (
        <section className="management-shelf" key={shelf}>
          <h2>
            {labels[shelf]}{' '}
            <span className="shelf-count">{shelves[shelf].length}</span>
          </h2>
          {shelves[shelf].length ? (
            <div className="thread-card-grid">
              {shelves[shelf].map((thread) => (
                <ThreadCard
                  key={thread.id}
                  thread={thread}
                  runs={runs}
                  checkouts={checkouts}
                  projectTitle={project.title}
                />
              ))}
            </div>
          ) : (
            <p className="empty-shelf">Nothing here.</p>
          )}
        </section>
      ))}
    </div>
  );
}
