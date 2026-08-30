import type { DashboardLiveStore } from '@pi-dashboard/client';
import type {
  CheckoutSummary,
  RuntimeSnapshot,
  SessionIndexEntry,
} from '@pi-dashboard/protocol';
import type { ComponentType, ReactNode, RefObject } from 'react';
import { useId, useState } from 'react';
import { sessionDisplayTitle } from '../../app-helpers';
import { useDashboardNavigate } from '../../routes/navigation';
import {
  DelegateHistorySurface,
  ExtensionSurfaceStack,
} from '../extension-surfaces';
import { InlineSessionRename } from '../session-rename';

export type SessionComposerProps = {
  runtime: RuntimeSnapshot | undefined;
  runtimes?: readonly RuntimeSnapshot[];
  session?: SessionIndexEntry;
  store?: DashboardLiveStore;
  sessionId: string;
  projectId?: string;
  checkoutId?: string;
  checkout?: CheckoutSummary;
  onMessageSubmitted?: () => void;
  onPromptSubmitted?: (text: string) => void;
};

function SessionProjectLink({
  projectId,
  projectLabel,
}: {
  projectId: string;
  projectLabel: string;
}) {
  const go = useDashboardNavigate();
  const href = `/projects/${encodeURIComponent(projectId)}`;
  return (
    <a
      className="session-workspace session-workspace-link"
      href={href}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        go(href);
      }}
    >
      {projectLabel}
    </a>
  );
}

export function sessionRelationships(
  id: string,
  session: Pick<SessionIndexEntry, 'parentSessionId'>,
  sessions: readonly SessionIndexEntry[],
): { parent?: SessionIndexEntry; children: SessionIndexEntry[] } {
  return {
    ...(session.parentSessionId
      ? {
          parent: sessions.find(
            (candidate) => candidate.id === session.parentSessionId,
          ),
        }
      : {}),
    children: sessions.filter((candidate) => candidate.parentSessionId === id),
  };
}

function SessionLink({ session }: { session: SessionIndexEntry }) {
  const go = useDashboardNavigate();
  const href = `/sessions/${encodeURIComponent(session.id)}`;
  return (
    <a
      href={href}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        go(href);
      }}
    >
      {sessionDisplayTitle(session)}
    </a>
  );
}

function SessionHeaderFrame({
  projectLabel,
  projectId,
  title,
  status,
  statusLabel,
  actions,
}: {
  projectLabel: string;
  projectId?: string;
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
              {projectId ? (
                <SessionProjectLink
                  projectId={projectId}
                  projectLabel={projectLabel}
                />
              ) : (
                <span className="session-workspace">{projectLabel}</span>
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
  projectName,
  projectId,
  data,
  entries,
  status,
  statusLabel,
  outlineTriggerRef,
  onOpenOutline,
  store,
  sessions,
}: {
  id: string;
  projectName: string;
  projectId?: string;
  data: Parameters<typeof sessionDisplayTitle>[0] &
    Pick<SessionIndexEntry, 'sessionKind' | 'parentSessionId'>;
  entries: readonly unknown[];
  status: string;
  statusLabel: string;
  outlineTriggerRef: RefObject<HTMLButtonElement | null>;
  onOpenOutline: () => void;
  store: DashboardLiveStore;
  sessions: readonly SessionIndexEntry[];
}) {
  const title = sessionDisplayTitle(data, entries);
  const { parent } = sessionRelationships(id, data, sessions);
  return (
    <SessionHeaderFrame
      projectLabel={projectName}
      projectId={projectId}
      title={
        <div className="session-title-with-parent">
          {data.sessionKind === 'delegate' ? (
            <h1>{title}</h1>
          ) : (
            <InlineSessionRename
              id={id}
              title={title}
              store={store}
              onRenamed={(name) => store.updateSessionMetadata(id, { name })}
            />
          )}
          {parent && (
            <span className="session-parent-link">
              ← Parent: <SessionLink session={parent} />
            </span>
          )}
        </div>
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

export { SessionHistoryControl } from './history-control';

/**
 * Keep task and delegate launchers available without spending a full row on
 * narrow screens. The launcher components remain mounted so their own drawer,
 * focus, and history state stays authoritative.
 */
export function RunStatusDisclosure({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return (
    <div className="run-status-disclosure">
      <button
        type="button"
        className="run-status-disclosure-trigger"
        aria-controls={contentId}
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="run-status-disclosure-title">Run status</span>
        <span className="run-status-disclosure-detail">
          Tasks and delegates
        </span>
        <span className="run-status-disclosure-chevron" aria-hidden="true">
          {expanded ? '⌃' : '⌄'}
        </span>
      </button>
      <div id={contentId} className="run-status-disclosure-content">
        {children}
      </div>
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
  session,
  sessionId,
  projectId,
  checkoutId,
  checkout,
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
  session?: SessionIndexEntry;
  sessionId: string;
  projectId: string | undefined;
  checkoutId: string | undefined;
  checkout?: CheckoutSummary;
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
          Jump to latest
        </button>
      )}
      <section
        className="extension-surfaces session-extension-surfaces"
        aria-label="Current tasks and delegates"
      >
        <RunStatusDisclosure>
          <ExtensionSurfaceStack
            runtime={runtime}
            placement="composer"
            excludeDelegate
            slotsOnly
          />
          <DelegateHistorySurface
            id={sessionId}
            runtime={runtime}
            sessionChange={sessionChange}
            store={store}
            slotsOnly
          />
        </RunStatusDisclosure>
      </section>
      <Composer
        key={sessionId}
        runtime={runtime}
        runtimes={runtimes}
        session={session}
        store={store}
        sessionId={sessionId}
        projectId={projectId}
        checkoutId={checkoutId}
        checkout={checkout}
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
      projectLabel="Session"
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
