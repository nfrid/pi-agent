import type { DashboardLiveStore } from '@pi-dashboard/client';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import type { ComponentType, ReactNode, RefObject } from 'react';
import { sessionDisplayTitle } from '../../app-helpers';
import {
  DelegateHistorySurface,
  ExtensionSurfaceStack,
} from '../extension-surfaces';
import { InlineSessionRename } from '../session-rename';

export type SessionComposerProps = {
  runtime: RuntimeSnapshot | undefined;
  runtimes?: readonly RuntimeSnapshot[];
  sessionId: string;
  workspaceId?: string;
  onMessageSubmitted?: () => void;
  onPromptSubmitted?: (text: string) => void;
};

function SessionHeaderFrame({
  workspaceLabel,
  workspaceId,
  title,
  status,
  statusLabel,
  actions,
}: {
  workspaceLabel: string;
  workspaceId?: string;
  title: ReactNode;
  status: string;
  statusLabel: string;
  actions?: ReactNode;
}) {
  return (
    <div className="session-context-slot">
      <header className="session-context session-heading">
        <div className="session-context-main">
          <div className="session-identity">
            <div className="session-breadcrumb">
              {workspaceId ? (
                <a
                  className="session-workspace session-workspace-link"
                  href={`/workspaces/${encodeURIComponent(workspaceId)}`}
                >
                  {workspaceLabel}
                </a>
              ) : (
                <span className="session-workspace">{workspaceLabel}</span>
              )}
              <span className="session-breadcrumb-separator" aria-hidden="true">
                /
              </span>
              {title}
            </div>
            <span className={`session-status status-${status}`}>
              <i aria-hidden="true">●</i> {statusLabel}
            </span>
          </div>
        </div>
        {actions ? (
          <div className="session-heading-actions">{actions}</div>
        ) : null}
      </header>
    </div>
  );
}

export function SessionLoadingCurtain({
  error,
  queryError,
  onRetry,
}: {
  error: string | undefined;
  queryError: Error | null;
  onRetry: () => void;
}) {
  return (
    <output
      className="session-loading-curtain session-transcript-loading"
      aria-live="polite"
    >
      <span className="session-loading-indicator" aria-hidden="true" />
      <p>
        {error ??
          (queryError instanceof Error
            ? queryError.message
            : 'Loading session…')}
      </p>
      {(error || queryError) && (
        <button type="button" className="secondary-button" onClick={onRetry}>
          Retry
        </button>
      )}
    </output>
  );
}

export function SessionHeader({
  id,
  workspaceName,
  workspaceId,
  data,
  entries,
  status,
  statusLabel,
  outlineTriggerRef,
  onOpenOutline,
  store,
}: {
  id: string;
  workspaceName: string;
  workspaceId?: string;
  data: Parameters<typeof sessionDisplayTitle>[0];
  entries: readonly unknown[];
  status: string;
  statusLabel: string;
  outlineTriggerRef: RefObject<HTMLButtonElement | null>;
  onOpenOutline: () => void;
  store: DashboardLiveStore;
}) {
  const title = sessionDisplayTitle(data, entries);
  return (
    <SessionHeaderFrame
      workspaceLabel={workspaceName}
      workspaceId={workspaceId}
      title={
        <InlineSessionRename
          id={id}
          title={title}
          store={store}
          onRenamed={(name) => store.updateSessionMetadata(id, { name })}
        />
      }
      status={status}
      statusLabel={statusLabel}
      actions={
        <button
          type="button"
          ref={outlineTriggerRef}
          className="session-icon-button outline-trigger"
          aria-label="Open transcript outline"
          aria-haspopup="dialog"
          onClick={onOpenOutline}
        >
          <span className="session-icon-glyph" aria-hidden="true">
            ≡
          </span>
        </button>
      }
    />
  );
}

export function SessionHistoryControl({
  loading,
  error,
  onLoad,
}: {
  loading: boolean;
  error: string | undefined;
  onLoad: () => void;
}) {
  return (
    <div className="session-history-control" aria-live="polite">
      <button
        type="button"
        className="secondary-button"
        onClick={onLoad}
        disabled={loading}
      >
        {loading
          ? 'Loading earlier history…'
          : error
            ? 'Retry earlier history'
            : 'Load earlier history'}
      </button>
      {error && (
        <span role="alert" className="session-history-error">
          {error}
        </span>
      )}
    </div>
  );
}

export function SessionControlLayer({
  controlLayerRef,
  awayFromLatest,
  onJumpToLatest,
  Composer,
  runtime,
  sessionChange,
  store,
  runtimes,
  sessionId,
  workspaceId,
  onPromptSubmitted,
}: {
  controlLayerRef: RefObject<HTMLDivElement | null>;
  awayFromLatest: boolean;
  onJumpToLatest: () => void;
  Composer: ComponentType<SessionComposerProps>;
  runtime: RuntimeSnapshot | undefined;
  sessionChange: number;
  store: DashboardLiveStore;
  runtimes: readonly RuntimeSnapshot[];
  sessionId: string;
  workspaceId: string | undefined;
  onPromptSubmitted: (text: string) => void;
}) {
  return (
    <div ref={controlLayerRef} className="session-control-layer">
      {awayFromLatest && (
        <button
          type="button"
          className="session-icon-button jump-latest"
          onClick={onJumpToLatest}
          aria-label="Jump to latest transcript activity"
        >
          ↓
        </button>
      )}
      <DelegateHistorySurface
        id={sessionId}
        runtime={runtime}
        sessionChange={sessionChange}
        store={store}
      />
      <ExtensionSurfaceStack
        runtime={runtime}
        placement="composer"
        excludeDelegate
      />
      <Composer
        key={sessionId}
        runtime={runtime}
        runtimes={runtimes}
        sessionId={sessionId}
        workspaceId={workspaceId}
        onMessageSubmitted={onJumpToLatest}
        onPromptSubmitted={onPromptSubmitted}
      />
    </div>
  );
}

export function SessionLoadingHeader({
  id,
  metadata,
  runtime,
  status,
  statusLabel,
}: {
  id: string;
  metadata: Parameters<typeof sessionDisplayTitle>[0] | undefined;
  runtime: RuntimeSnapshot | undefined;
  status: string;
  statusLabel: string;
}) {
  return (
    <SessionHeaderFrame
      workspaceLabel="Session"
      title={
        <h1>
          {metadata
            ? sessionDisplayTitle(metadata)
            : runtime?.session.title || runtime?.session.name || id}
        </h1>
      }
      status={status}
      statusLabel={statusLabel}
    />
  );
}
