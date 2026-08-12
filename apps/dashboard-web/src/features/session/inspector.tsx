import type { DashboardLiveStore } from '@pi-dashboard/client';
import type {
  RuntimeSnapshot,
  SessionApiResponse,
} from '@pi-dashboard/protocol';
import { sessionDisplayTitle } from '../../app-helpers';
import { DashboardDialog } from '../dashboard-dialog';
import { RuntimeActions } from '../runtime-actions';
import { SessionRename } from '../session-rename';

type SessionInspectorData = Pick<SessionApiResponse, 'metadata' | 'entries'>;

export function SessionInspector({
  id,
  open,
  onClose,
  data,
  runtime,
  runtimeError,
  store,
}: {
  id: string;
  open: boolean;
  onClose: () => void;
  data: SessionInspectorData;
  runtime: RuntimeSnapshot | undefined;
  runtimeError: string | undefined;
  store: DashboardLiveStore;
}) {
  const title = sessionDisplayTitle(data.metadata, data.entries);
  return (
    <DashboardDialog
      dialogId="session-inspector"
      titleId="session-inspector-title"
      title={title}
      eyebrow="Session details"
      closeLabel="Close session details"
      className="surface-dialog session-inspector"
      isOpen={open}
      onClose={onClose}
    >
      <div className="inspector-body">
        <section
          className="inspector-section"
          aria-labelledby="inspector-rename-heading"
        >
          <h3 id="inspector-rename-heading">Name</h3>
          <SessionRename
            id={id}
            initialName={data.metadata.name}
            store={store}
            onRenamed={(name) => store.updateSessionMetadata(id, { name })}
          />
        </section>
        {runtime && (
          <section
            className="inspector-section"
            aria-labelledby="inspector-controls-heading"
          >
            <h3 id="inspector-controls-heading">Runtime controls</h3>
            <RuntimeActions runtime={runtime} />
          </section>
        )}
        {runtimeError && (
          <div className="error notice inspector-error" role="alert">
            Runtime failure: {runtimeError}
          </div>
        )}
        {!runtime && (
          <p className="muted">
            No active runtime is attached to this session.
          </p>
        )}
      </div>
    </DashboardDialog>
  );
}
