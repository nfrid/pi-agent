import {
  applyTranscriptEvent,
  createTranscriptProjection,
  hydrateTranscript,
  type TranscriptItem,
  type TranscriptProjection,
} from '@pi-dashboard/domain';
import {
  type AuthoritativeSessionSnapshot,
  type BridgeEvent,
  type BrowserSnapshot,
  type DelegateLiveRun,
  type InteractionSnapshot,
  type NormalizedMessagePayload,
  type NormalizedToolPayload,
  type NotificationEvent,
  PROTOCOL_VERSION,
  type RuntimeSnapshot,
  type RuntimeSnapshotPatch,
  type SessionIndexEntry,
  type SessionSnapshot,
  tryParseDelegateTranscriptEntry,
  type WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { DashboardEventStream } from '../event-stream.js';
import type { MetadataStore } from '../metadata.js';
import type { PushSender } from '../push.js';
import type { SqliteOrchestrationRepository } from '../repositories/sqlite-orchestration-repository.js';
import type { RuntimeManager } from '../runtime-manager.js';
import type { RegistryChange, RuntimeRegistry } from '../runtime-registry.js';
import type { SeshAdapter } from '../sesh.js';
import type { SessionIndex } from '../session-index.js';
import type { UsageProvider } from '../usage.js';
import { ComposerCommandService } from './composer-command-service.js';
import { NotificationService } from './notification-service.js';
import type { OrchestrationService } from './orchestration-service.js';
import { RuntimeService } from './runtime-service.js';
import { SessionService } from './session-service.js';
import { UploadService } from './upload-service.js';
import { UsageService } from './usage-service.js';
import { WorkspaceService } from './workspace-service.js';

export interface ApplicationChange {
  type: 'event' | 'snapshot';
  event?: BridgeEvent;
  runtimeId?: string;
  runtimeEpoch?: string;
  runtimeSeq?: number;
  sessionId?: string;
  snapshot?: RuntimeSnapshot;
}

export interface DashboardApplicationOptions {
  registry: RuntimeRegistry;
  manager: RuntimeManager;
  sessions: SessionIndex;
  metadata: MetadataStore;
  sesh: SeshAdapter;
  usage: UsageProvider;
  push: PushSender;
  stateDir: string;
  eventStream?: DashboardEventStream;
  onChange?: () => void;
  orchestration?: OrchestrationService;
}

export interface SessionMetadataDelta {
  readonly upsert: readonly SessionIndexEntry[];
  readonly remove: readonly string[];
}

const SESSION_METADATA_FIELDS = [
  'file',
  'cwd',
  'workspaceId',
  'name',
  'title',
  'startedAt',
  'updatedAt',
  'activeRuntimeId',
  'entryCount',
] as const satisfies readonly (keyof SessionIndexEntry)[];

function sameSessionMetadata(
  left: SessionIndexEntry,
  right: SessionIndexEntry,
): boolean {
  return SESSION_METADATA_FIELDS.every((field) => left[field] === right[field]);
}

/** Remove transcript payloads before an event crosses the browser boundary. */
export function compactPublicSession(
  session: SessionSnapshot,
): SessionSnapshot {
  return { ...session, entries: [], entriesComplete: false };
}

function compactPublicExtensionSurfaces(
  surfaces: RuntimeSnapshot['extensionSurfaces'],
): RuntimeSnapshot['extensionSurfaces'] {
  return surfaces?.map((surface) => {
    if (
      surface.rendererId !== 'delegate.status' ||
      !surface.viewModel ||
      typeof surface.viewModel !== 'object' ||
      !Array.isArray((surface.viewModel as { statuses?: unknown }).statuses)
    )
      return surface;
    const statuses = (
      surface.viewModel as { statuses: Array<Record<string, unknown>> }
    ).statuses.map((status) => {
      const { transcript: _transcript, result, ...metadata } = status;
      const compactResult =
        result && typeof result === 'object'
          ? (() => {
              const { value, ...resultMetadata } = result as Record<
                string,
                unknown
              >;
              return {
                ...resultMetadata,
                ...(value === undefined ? {} : { valueOmitted: true }),
              };
            })()
          : result;
      return {
        ...metadata,
        ...(compactResult === undefined ? {} : { result: compactResult }),
      };
    });
    return {
      ...surface,
      viewModel: { ...surface.viewModel, statuses },
    };
  });
}

function compactPublicRuntime<T extends RuntimeSnapshot | RuntimeSnapshotPatch>(
  runtime: T,
): T {
  return {
    ...runtime,
    ...(runtime.session === undefined
      ? {}
      : { session: compactPublicSession(runtime.session) }),
    ...(runtime.extensionSurfaces === undefined
      ? {}
      : {
          extensionSurfaces: compactPublicExtensionSurfaces(
            runtime.extensionSurfaces,
          ),
        }),
  } as T;
}

function shellRuntime(runtime: RuntimeSnapshot): RuntimeSnapshot {
  const compacted = compactPublicRuntime(runtime);
  let truncated = false;
  const pendingInteractions = runtime.pendingInteractions
    .slice(0, 128)
    .filter((interaction) => {
      const keep =
        Buffer.byteLength(JSON.stringify(interaction) ?? '') <=
        MAX_SHELL_INTERACTION_BYTES;
      if (!keep) truncated = true;
      return keep;
    });
  if (runtime.pendingInteractions.length > pendingInteractions.length)
    truncated = true;
  const extensionSurfaces = compacted.extensionSurfaces
    ?.slice(0, MAX_SHELL_SURFACES)
    .map((surface) => {
      const bytes = Buffer.byteLength(JSON.stringify(surface) ?? '');
      if (bytes <= MAX_SHELL_SURFACE_BYTES) return surface;
      truncated = true;
      return { ...surface, viewModel: { truncated: true } };
    });
  if ((compacted.extensionSurfaces?.length ?? 0) > MAX_SHELL_SURFACES)
    truncated = true;
  return {
    ...compacted,
    pendingInteractions,
    ...(extensionSurfaces === undefined ? {} : { extensionSurfaces }),
    ...(truncated ? { shellStateTruncated: true } : {}),
  } as RuntimeSnapshot;
}

function boundedShellUsage(value: unknown): unknown {
  if (value === undefined) return value;
  return Buffer.byteLength(JSON.stringify(value) ?? '') <=
    MAX_SHELL_SURFACE_BYTES
    ? value
    : { truncated: true };
}

const MAX_ACTIVE_ENTITIES = 256;
const MAX_ACTIVE_BYTES = 512 * 1024;
const MAX_SHELL_INTERACTION_BYTES = 32 * 1024;
const MAX_SHELL_SURFACE_BYTES = 64 * 1024;
const MAX_SHELL_SURFACES = 32;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,200}$/;

type ActiveTranscriptState = {
  runtimeId: string;
  runtimeEpoch: string;
  runtimeSeq: number;
  liveState: RuntimeSnapshot['liveState'];
  pendingInteractions: readonly InteractionSnapshot[];
  projection: TranscriptProjection;
  truncated: boolean;
  /** Terminal lifecycle entities not yet observed in a persisted page. */
  unresolvedTerminalIds: readonly string[];
  /** Set on settlement/offline/reconnect until a complete disk read proves safety. */
  uncertain: boolean;
};

type ActiveCapture = {
  runtime?: RuntimeSnapshot;
  state?: ActiveTranscriptState;
};

function sameRuntimeCapture(
  left: ActiveCapture,
  right: ActiveCapture,
): boolean {
  return (
    left.runtime?.runtimeId === right.runtime?.runtimeId &&
    left.state?.runtimeEpoch === right.state?.runtimeEpoch &&
    left.state?.runtimeSeq === right.state?.runtimeSeq
  );
}

function trimProjection(
  projection: TranscriptProjection,
  wasTruncated: boolean,
): { projection: TranscriptProjection; truncated: boolean } {
  const selected: string[] = [];
  const items: Record<string, TranscriptItem> = {};
  let bytes = 0;
  let truncated = wasTruncated;
  for (let index = projection.order.length - 1; index >= 0; index -= 1) {
    const id = projection.order[index];
    const item = id === undefined ? undefined : projection.items[id];
    if (!id || !item) continue;
    const itemBytes = Buffer.byteLength(JSON.stringify(item) ?? '');
    if (
      selected.length >= MAX_ACTIVE_ENTITIES ||
      bytes + itemBytes > MAX_ACTIVE_BYTES
    ) {
      truncated = true;
      continue;
    }
    selected.push(id);
    items[id] = item;
    bytes += itemBytes;
  }
  selected.reverse();
  return {
    projection: { ...projection, order: selected, items },
    truncated,
  };
}

function activeDelegateRuns(runtime: RuntimeSnapshot): {
  runs: DelegateLiveRun[];
  truncated: boolean;
} {
  const surface = runtime.extensionSurfaces?.find(
    (item) => item.rendererId === 'delegate.status',
  );
  const model = surface?.viewModel;
  const statuses =
    model && typeof model === 'object' && !Array.isArray(model)
      ? (model as { statuses?: unknown }).statuses
      : undefined;
  if (!Array.isArray(statuses)) return { runs: [], truncated: false };
  const runs: DelegateLiveRun[] = [];
  let truncated = statuses.length > 64;
  for (const raw of statuses.slice(0, 64)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const value = raw as Record<string, unknown>;
    const state = value.state;
    const pauseState = value.pauseState;
    if (
      !(
        state === 'queued' ||
        state === 'running' ||
        pauseState === 'pausing' ||
        pauseState === 'paused'
      )
    )
      continue;
    if (
      typeof value.runId !== 'string' ||
      typeof value.lineageId !== 'string' ||
      typeof value.name !== 'string' ||
      (value.kind !== 'foreground' && value.kind !== 'background') ||
      typeof value.createdAt !== 'number' ||
      !Number.isFinite(value.createdAt) ||
      typeof value.allowWrites !== 'boolean'
    )
      continue;
    const sourceTranscript = Array.isArray(value.transcript)
      ? value.transcript
      : [];
    if (value.transcript !== undefined && !Array.isArray(value.transcript))
      truncated = true;
    if (sourceTranscript.length > 128) truncated = true;
    const transcript = sourceTranscript.flatMap((entry) => {
      const parsed = tryParseDelegateTranscriptEntry(entry);
      return parsed ? [parsed] : [];
    });
    if (transcript.length !== Math.min(sourceTranscript.length, 128))
      truncated = true;
    runs.push({
      runId: value.runId,
      lineageId: value.lineageId,
      name: value.name,
      kind: value.kind,
      state: state === 'queued' ? 'queued' : 'running',
      createdAt: value.createdAt,
      ...(typeof value.startedAt === 'number'
        ? { startedAt: value.startedAt }
        : {}),
      ...(typeof value.finishedAt === 'number'
        ? { finishedAt: value.finishedAt }
        : {}),
      ...(typeof value.jobId === 'string' ? { jobId: value.jobId } : {}),
      ...(typeof value.route === 'string' ? { route: value.route } : {}),
      ...(value.context === 'branch' ||
      value.context === 'fresh' ||
      value.context === 'continuation'
        ? { context: value.context }
        : {}),
      allowWrites: value.allowWrites,
      ...(pauseState === 'pausing' || pauseState === 'paused'
        ? { pauseState }
        : {}),
      ...(typeof value.pausedAt === 'number'
        ? { pausedAt: value.pausedAt }
        : {}),
      transcript: transcript.slice(0, 128),
      ...(value.transcriptTruncated === true
        ? { transcriptTruncated: true }
        : {}),
    });
  }
  return { runs, truncated };
}

function itemMessage(
  item: TranscriptItem,
  includeTerminal = false,
): NormalizedMessagePayload | undefined {
  if (
    item.kind !== 'message' ||
    (item.status !== 'streaming' &&
      !(includeTerminal && item.status === 'finished'))
  )
    return undefined;
  return {
    messageId: item.messageId,
    role: item.role,
    content: item.content,
    ...(item.timestamp === undefined ? {} : { timestamp: item.timestamp }),
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
    ...(item.toolCallIds === undefined
      ? {}
      : { toolCallIds: [...item.toolCallIds] }),
    phase: item.status === 'streaming' ? 'updated' : 'finished',
    ...(item.data === undefined ? {} : { data: item.data }),
  };
}

function itemTool(
  item: TranscriptItem,
  includeTerminal = false,
): NormalizedToolPayload | undefined {
  if (
    item.kind !== 'tool' ||
    (item.status !== 'pending' &&
      item.status !== 'running' &&
      !(
        includeTerminal &&
        (item.status === 'finished' || item.status === 'error')
      ))
  )
    return undefined;
  return {
    toolCallId: item.toolCallId,
    name: item.name,
    ...(item.arguments === undefined ? {} : { arguments: item.arguments }),
    ...(item.result === undefined ? {} : { result: item.result }),
    ...(item.isError === undefined ? {} : { isError: item.isError }),
    status: item.status,
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
    ...(item.data === undefined ? {} : { data: item.data }),
    phase:
      item.status === 'pending' || item.status === 'running'
        ? 'updated'
        : 'finished',
  };
}

/**
 * Public event projection. RuntimeRegistry retains full snapshots for server
 * authority, but SSE and WebSocket consumers only receive metadata patches.
 */
export function projectPublicBridgeEvent(event: BridgeEvent): BridgeEvent {
  switch (event.type) {
    case 'runtime.hello':
      return {
        ...event,
        snapshot: compactPublicRuntime(event.snapshot),
      };
    case 'runtime.heartbeat':
    case 'runtime.stateChanged':
      return event.snapshot === undefined
        ? event
        : {
            ...event,
            snapshot: compactPublicRuntime(event.snapshot),
          };
    case 'session.changed':
    case 'session.snapshot':
      return { ...event, session: compactPublicSession(event.session) };
    default:
      return event;
  }
}

/** Framework-independent application boundary for the dashboard daemon. */
export class DashboardApplication {
  readonly runtime: RuntimeService;
  readonly sessions: SessionService;
  readonly workspaces: WorkspaceService;
  readonly notifications: NotificationService;
  readonly composerCommands: ComposerCommandService;
  readonly usage: UsageService;
  readonly uploads: UploadService;
  readonly eventStream: DashboardEventStream;
  private readonly registry: RuntimeRegistry;
  private readonly manager: RuntimeManager;
  private readonly metadata: MetadataStore;
  readonly orchestration: SqliteOrchestrationRepository;
  private readonly sessionIndex: SessionIndex;
  /** Metadata emitted by the last authoritative snapshot/index publication. */
  private sessionMetadataBaseline?: ReadonlyMap<string, SessionIndexEntry>;
  /** Bounded, process-local live transcript projection; never persisted. */
  private readonly activeTranscripts = new Map<string, ActiveTranscriptState>();
  readonly orchestrationService?: OrchestrationService;

  constructor(options: DashboardApplicationOptions) {
    this.registry = options.registry;
    this.manager = options.manager;
    this.metadata = options.metadata;
    this.orchestration = options.metadata.orchestration;
    this.sessionIndex = options.sessions;
    this.orchestrationService = options.orchestration;
    this.eventStream = options.eventStream ?? new DashboardEventStream(256);
    this.runtime = new RuntimeService(
      options.registry,
      options.manager,
      options.sessions,
    );
    this.sessions = new SessionService(options.sessions);
    this.workspaces = new WorkspaceService(
      options.sesh,
      options.manager,
      options.sessions,
      options.metadata,
      options.onChange,
    );
    this.notifications = new NotificationService(
      options.metadata,
      options.push,
    );
    this.composerCommands = new ComposerCommandService();
    this.usage = new UsageService(options.usage, options.onChange);
    this.uploads = new UploadService(options.stateDir);
  }

  async start(): Promise<void> {
    await this.uploads.start();
    await this.workspaces.refresh();
    await this.sessionsStart();
    this.initializeSessionMetadataBaseline();
  }

  async refreshWorkspaces(): Promise<WorkspaceTarget[]> {
    return this.workspaces.refresh();
  }

  setPush(push: PushSender): void {
    this.notifications.setPush(push);
  }

  /** Authoritative session metadata, including live runtime overlays. */
  sessionMetadata(
    liveRuntimes = this.registry.snapshots(),
  ): SessionIndexEntry[] {
    const activeRuntimes = new Map(
      liveRuntimes
        .filter((runtime) => runtime.online !== false)
        .map((runtime) => [runtime.session.id, runtime]),
    );
    return this.sessions.list().map((session) => {
      const runtime = activeRuntimes.get(session.id);
      return {
        ...session,
        ...(runtime?.session.name !== undefined
          ? { name: runtime.session.name }
          : {}),
        ...(runtime?.session.title !== undefined
          ? { title: runtime.session.title }
          : {}),
        activeRuntimeId: runtime?.runtimeId,
      };
    });
  }

  private setSessionMetadataBaseline(
    sessions: readonly SessionIndexEntry[],
  ): void {
    this.sessionMetadataBaseline = new Map(
      sessions.map((session) => [session.id, session]),
    );
  }

  /** Establish the metadata comparison point before watcher callbacks publish. */
  initializeSessionMetadataBaseline(
    liveRuntimes = this.registry.snapshots(),
  ): void {
    this.setSessionMetadataBaseline(this.sessionMetadata(liveRuntimes));
  }

  /**
   * Compare current authoritative metadata with the last snapshot/index
   * publication. The baseline advances even when there is no delta, so a
   * runtime overlay observed between watcher callbacks cannot be replayed as
   * stale metadata later.
   */
  sessionMetadataDelta(): SessionMetadataDelta | undefined {
    const current = this.sessionMetadata();
    const prior = this.sessionMetadataBaseline;
    this.setSessionMetadataBaseline(current);
    if (!prior) return undefined;
    const currentById = new Map(
      current.map((session) => [session.id, session]),
    );
    const upsert = current.filter((session) => {
      const previous = prior.get(session.id);
      return previous === undefined || !sameSessionMetadata(previous, session);
    });
    const remove = [...prior.keys()].filter((id) => !currentById.has(id));
    if (upsert.length === 0 && remove.length === 0) return undefined;
    return { upsert, remove };
  }

  /** Build a shell snapshot synchronously from one daemon cursor. */
  shellSnapshot(serverId: string, revision: number): BrowserSnapshot {
    const cursor = this.eventStream.cursor;
    const liveRuntimes = this.registry.snapshots();
    const sessions = this.sessionMetadata(liveRuntimes);
    this.setSessionMetadataBaseline(sessions);
    return {
      serverId,
      revision,
      cursor,
      runtimes: liveRuntimes.map((runtime) => shellRuntime(runtime)),
      workspaces: this.workspaces.list(),
      projects: this.orchestration.projectSummaries(),
      checkouts: this.orchestration.checkoutSummaries(),
      threads: this.orchestration.threadSummaries(),
      runs: this.orchestration.runSummaries(),
      sessions,
      usage: boundedShellUsage(this.usage.cached()),
      unread: this.metadata.unreadNotifications(),
    };
  }

  /** Compatibility builder retained for bootstrap, SSE, and websocket paths. */
  snapshot(
    serverId: string,
    revision: number,
    cursor = this.eventStream.cursor,
  ): BrowserSnapshot {
    // Event-stream publication passes its allocated cursor explicitly. Keep
    // this compatibility builder independent of the stricter shell query so
    // bootstrap/SSE/WS payloads retain their historical shape.
    const liveRuntimes = this.registry.snapshots();
    const sessions = this.sessionMetadata(liveRuntimes);
    this.setSessionMetadataBaseline(sessions);
    return {
      serverId,
      revision,
      cursor,
      runtimes: liveRuntimes.map((runtime) => compactPublicRuntime(runtime)),
      workspaces: this.workspaces.list(),
      projects: this.orchestration.projectSummaries(),
      checkouts: this.orchestration.checkoutSummaries(),
      threads: this.orchestration.threadSummaries(),
      runs: this.orchestration.runSummaries(),
      sessions,
      usage: this.usage.cached(),
      unread: this.metadata.unreadNotifications(),
    };
  }

  private updateActiveTranscript(change: RegistryChange): void {
    const sessionId = change.snapshot.session?.id;
    if (!sessionId) return;
    if (change.kind === 'offline') {
      const prior = this.activeTranscripts.get(sessionId);
      if (prior)
        this.activeTranscripts.set(sessionId, {
          ...prior,
          uncertain: true,
        });
      return;
    }
    const runtimeEpoch = change.runtimeEpoch ?? change.snapshot.runtimeId;
    const runtimeSeq = change.runtimeSeq ?? 0;
    if (change.kind === 'registered') {
      this.activeTranscripts.set(sessionId, {
        runtimeId: change.snapshot.runtimeId,
        runtimeEpoch,
        runtimeSeq,
        liveState: change.snapshot.liveState,
        pendingInteractions: change.snapshot.pendingInteractions.slice(0, 128),
        projection: createTranscriptProjection(sessionId),
        truncated: false,
        unresolvedTerminalIds: [],
        // A fresh registration starts with a complete live observation. A
        // reconnect starts uncertain because its earlier lifecycle is unknown.
        uncertain: change.reconnected === true,
      });
      return;
    }
    const prior = this.activeTranscripts.get(sessionId) ?? {
      runtimeId: change.snapshot.runtimeId,
      runtimeEpoch,
      runtimeSeq: runtimeSeq - 1,
      liveState: change.snapshot.liveState,
      pendingInteractions: [],
      projection: createTranscriptProjection(sessionId),
      truncated: false,
      unresolvedTerminalIds: [],
      uncertain: true,
    };
    if (prior.runtimeEpoch !== runtimeEpoch) {
      this.activeTranscripts.set(sessionId, {
        ...prior,
        runtimeId: change.snapshot.runtimeId,
        runtimeEpoch,
        runtimeSeq,
        liveState: change.snapshot.liveState,
        pendingInteractions: change.snapshot.pendingInteractions.slice(0, 128),
        projection: createTranscriptProjection(sessionId),
        truncated: false,
        unresolvedTerminalIds: [],
        uncertain: true,
      });
      return;
    }
    let projection = prior.projection;
    let truncated = prior.truncated;
    let unresolvedTerminalIds = [...prior.unresolvedTerminalIds];
    let uncertain = prior.uncertain;
    if (change.kind === 'event') {
      const settled = change.event.type === 'agent.settled';
      if (!settled) {
        const reduced = applyTranscriptEvent(projection, {
          event: change.event,
          sessionId,
          runtimeEpoch,
          runtimeSeq,
        });
        projection = reduced.state;
        if (
          change.event.type === 'message.finished' ||
          change.event.type === 'tool.finished'
        ) {
          unresolvedTerminalIds = [
            ...new Set(
              projection.order.filter((id) => {
                const item = projection.items[id];
                return (
                  (item?.kind === 'message' && item.status === 'finished') ||
                  (item?.kind === 'tool' &&
                    (item.status === 'finished' || item.status === 'error'))
                );
              }),
            ),
          ];
          // A malformed terminal payload may not produce a reducer item. It
          // is still unsafe to claim durability until a complete read proves
          // that no lifecycle state was lost.
          if (unresolvedTerminalIds.length === 0) uncertain = true;
        }
        // Live lifecycle events update the bounded projection but do not
        // prove that earlier persisted lifecycle events were replayed. In
        // particular, they must not clear uncertainty carried by reconnect.
        if (
          (change.event.type === 'message.finished' ||
            change.event.type === 'tool.finished') &&
          unresolvedTerminalIds.length === 0
        )
          uncertain = true;
      } else {
        // Keep terminal items visible until the persisted read confirms them.
        uncertain = true;
      }
      const trimmed = trimProjection(projection, truncated);
      projection = trimmed.projection;
      truncated = trimmed.truncated;
    }
    this.activeTranscripts.set(sessionId, {
      ...prior,
      runtimeId: change.snapshot.runtimeId,
      runtimeEpoch,
      runtimeSeq,
      liveState: change.snapshot.liveState,
      pendingInteractions: change.snapshot.pendingInteractions.slice(0, 128),
      projection,
      truncated,
      unresolvedTerminalIds,
      uncertain:
        change.kind === 'event' && change.event.type === 'runtime.goodbye'
          ? true
          : uncertain,
    });
  }

  private captureActive(sessionId: string): ActiveCapture {
    const runtime = this.registry
      .snapshots()
      .find((item) => item.session.id === sessionId && item.online !== false);
    const state = this.activeTranscripts.get(sessionId);
    return { runtime, state };
  }

  private activeOverlay(
    capture: ActiveCapture,
  ): AuthoritativeSessionSnapshot['active'] {
    const state = capture.state;
    const runtime = capture.runtime;
    const messages: NormalizedMessagePayload[] = [];
    const tools: NormalizedToolPayload[] = [];
    const unresolved = new Set(state?.unresolvedTerminalIds ?? []);
    if (state) {
      for (const id of state.projection.order) {
        const item = state.projection.items[id];
        if (!item) continue;
        const message = itemMessage(item, unresolved.has(id));
        if (message) messages.push(message);
        const tool = itemTool(item, unresolved.has(id));
        if (tool) tools.push(tool);
      }
    }
    let pending = (
      state?.pendingInteractions ??
      runtime?.pendingInteractions ??
      []
    )
      .slice(0, 128)
      .map((interaction) => ({
        ...interaction,
        choices: [...interaction.choices],
      }));
    const delegateProjection = runtime
      ? activeDelegateRuns(runtime)
      : { runs: [], truncated: false };
    let delegates = delegateProjection.runs;
    let truncated =
      (state?.truncated ?? false) ||
      (state?.uncertain ?? false) ||
      unresolved.size > 0 ||
      delegateProjection.truncated;
    if (
      (state?.pendingInteractions.length ??
        runtime?.pendingInteractions.length ??
        0) > pending.length
    )
      truncated = true;
    const bytes = (value: unknown): number =>
      Buffer.byteLength(JSON.stringify(value) ?? '');
    while (
      bytes({ messages, tools, delegates, pendingInteractions: pending }) >
        MAX_ACTIVE_BYTES &&
      pending.length > 0
    ) {
      pending = pending.slice(1);
      truncated = true;
    }
    while (
      bytes({ messages, tools, delegates, pendingInteractions: pending }) >
        MAX_ACTIVE_BYTES &&
      (delegates.length > 0 || tools.length > 0 || messages.length > 0)
    ) {
      if (delegates.length > 0) delegates = delegates.slice(1);
      else if (tools.length > 0) tools.splice(0, 1);
      else messages.splice(0, 1);
      truncated = true;
    }
    return {
      ...(runtime ? { runtimeId: runtime.runtimeId } : {}),
      ...(state?.runtimeEpoch === undefined
        ? {}
        : { runtimeEpoch: state.runtimeEpoch }),
      ...(state && state.runtimeSeq >= 0
        ? { runtimeSeq: state.runtimeSeq }
        : {}),
      ...(runtime ? { liveState: runtime.liveState } : {}),
      pendingInteractions: pending,
      messages,
      tools,
      delegates,
      truncated,
    };
  }

  /**
   * Read persisted history and the bounded active projection under one
   * runtime/cursor capture. A changing runtime epoch or sequence is retried;
   * no disk page is ever paired with a different live runtime.
   */
  async sessionSnapshot(
    serverId: string,
    sessionId: string,
    before?: string,
  ): Promise<AuthoritativeSessionSnapshot> {
    if (!SESSION_ID_PATTERN.test(sessionId))
      throw new Error('Invalid session id.');
    type SessionRead = Awaited<ReturnType<SessionIndex['readEntries']>>;
    const runtimeLeafId = (
      runtime: RuntimeSnapshot | undefined,
    ): string | undefined => {
      const leafId = runtime
        ? (runtime.session as { leafId?: unknown }).leafId
        : undefined;
      return typeof leafId === 'string' && leafId.length > 0
        ? leafId
        : undefined;
    };
    const runtimeIsWorking = (runtime: RuntimeSnapshot | undefined): boolean =>
      runtime?.liveState === 'working' || runtime?.liveState === 'compacting';
    const runtimeMetadata = (
      runtime: RuntimeSnapshot,
      indexed: SessionIndexEntry | undefined,
    ): SessionIndexEntry => ({
      ...(indexed ?? {
        id: sessionId,
        file: runtime.session.file ?? '',
        cwd: runtime.session.cwd ?? runtime.cwd,
        updatedAt: runtime.lastSeenAt ?? Date.now(),
      }),
      id: sessionId,
      file: runtime.session.file ?? indexed?.file ?? '',
      cwd: runtime.session.cwd ?? indexed?.cwd ?? runtime.cwd,
      ...(runtime.session.name === undefined
        ? indexed?.name === undefined
          ? {}
          : { name: indexed.name }
        : { name: runtime.session.name }),
      ...(runtime.session.title === undefined
        ? indexed?.title === undefined
          ? {}
          : { title: indexed.title }
        : { title: runtime.session.title }),
      activeRuntimeId: runtime.runtimeId,
      entryCount: runtime.session.entries.length,
    });
    const boundedRuntimeRead = (
      runtime: RuntimeSnapshot,
      indexed: SessionIndexEntry | undefined,
    ): SessionRead => {
      const entries = runtime.session.entries.slice(-2048);
      const complete =
        runtime.session.entriesComplete === true &&
        entries.length === runtime.session.entries.length;
      return {
        metadata: runtimeMetadata(runtime, indexed),
        entries: [...entries],
        entriesComplete: complete,
        // A runtime-only page has no opaque file cursor. Do not advertise a
        // pageable older range that cannot be requested safely.
        history: {
          version: 1,
          start: 0,
          end: entries.length,
          hasOlder: false,
        },
      };
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cursor = this.eventStream.cursor;
      const capture = before === undefined ? this.captureActive(sessionId) : {};
      const indexed = this.sessionIndex.get(sessionId);
      let result: SessionRead;
      try {
        if (!indexed && capture.runtime)
          result = boundedRuntimeRead(capture.runtime, indexed);
        else
          result = await this.sessionIndex.readEntries(
            sessionId,
            before,
            before === undefined && !runtimeIsWorking(capture.runtime)
              ? runtimeLeafId(capture.runtime)
              : undefined,
            {
              resolveLatestLeaf:
                before === undefined && runtimeIsWorking(capture.runtime),
            },
          );
      } catch (error) {
        if (!capture.runtime || before !== undefined) throw error;
        result = boundedRuntimeRead(capture.runtime, indexed);
      }
      if (
        before === undefined &&
        (this.eventStream.cursor !== cursor ||
          !sameRuntimeCapture(capture, this.captureActive(sessionId)))
      )
        continue;
      let resolvedCapture = capture;
      if (before === undefined && capture.state) {
        const persisted = hydrateTranscript(result.entries, sessionId);
        const persistedIds = new Set(Object.keys(persisted.items));
        const unresolvedTerminalIds =
          capture.state.unresolvedTerminalIds.filter(
            (id) => !persistedIds.has(id),
          );
        const fullyProved =
          result.entriesComplete &&
          unresolvedTerminalIds.length === 0 &&
          !runtimeIsWorking(capture.runtime);
        const state = {
          ...capture.state,
          unresolvedTerminalIds,
          uncertain: fullyProved ? false : capture.state.uncertain,
        };
        this.activeTranscripts.set(sessionId, state);
        resolvedCapture = { ...capture, state };
      }
      const active =
        before === undefined
          ? this.activeOverlay(resolvedCapture)
          : this.activeOverlay({});
      const provenance = resolvedCapture.runtime
        ? this.registry.transportProvenance(resolvedCapture.runtime.runtimeId)
        : undefined;
      const runtimeEpoch =
        provenance?.runtimeEpoch ?? resolvedCapture.state?.runtimeEpoch;
      const runtimeSeq =
        provenance?.runtimeSeq ?? resolvedCapture.state?.runtimeSeq;
      const metadata = resolvedCapture.runtime
        ? runtimeMetadata(resolvedCapture.runtime, result.metadata)
        : result.metadata;
      const completeThroughCursor =
        before === undefined &&
        result.entriesComplete &&
        !active.truncated &&
        (!resolvedCapture.runtime || resolvedCapture.state !== undefined);
      return {
        metadata,
        entries: result.entries,
        ...(result.history ? { history: result.history } : {}),
        entriesComplete: result.entriesComplete,
        serverId,
        cursor,
        ...(runtimeEpoch === undefined ? {} : { runtimeEpoch }),
        ...(runtimeSeq === undefined || runtimeSeq < 0 ? {} : { runtimeSeq }),
        active,
        completeThroughCursor,
      };
    }
    throw new Error('Runtime changed while reading session snapshot; retry.');
  }

  onRegistryChange(change: RegistryChange): ApplicationChange {
    this.updateActiveTranscript(change);
    this.orchestrationService?.onRegistryChange(change);
    if (this.notifications.shouldPersistRuntime(change))
      this.metadata.saveRuntime(change.snapshot);
    this.manager.onRegistryChange(change);
    this.notifications.handle(change);
    const provenance = {
      ...(change.runtimeEpoch === undefined
        ? {}
        : { runtimeEpoch: change.runtimeEpoch }),
      ...(change.runtimeSeq === undefined
        ? {}
        : { runtimeSeq: change.runtimeSeq }),
    };
    if (change.kind === 'registered' && change.reconnected) {
      const snapshot = {
        ...change.snapshot,
        session: {
          ...change.snapshot.session,
          entries: [],
          entriesComplete: false,
        },
      };
      return {
        type: 'event',
        event: {
          type: 'runtime.hello',
          protocolVersion: PROTOCOL_VERSION,
          snapshot,
        },
        runtimeId: snapshot.runtimeId,
        sessionId: snapshot.session.id,
        ...provenance,
      };
    }
    if (change.kind === 'offline')
      return {
        type: 'event',
        event: {
          type: 'runtime.stateChanged',
          state: change.snapshot.liveState,
          snapshot: {
            online: false,
            ...(change.snapshot.lastSeenAt === undefined
              ? {}
              : { lastSeenAt: change.snapshot.lastSeenAt }),
          },
        },
        runtimeId: change.snapshot.runtimeId,
        sessionId: change.snapshot.session.id,
        ...provenance,
      };
    if (change.kind === 'event')
      return {
        type: 'event',
        event: projectPublicBridgeEvent(change.event),
        runtimeId: change.runtimeId,
        ...provenance,
      };
    return { type: 'snapshot', snapshot: change.snapshot };
  }

  markNotificationRead(id: string): void {
    this.metadata.markNotificationRead(id);
  }

  markAllNotificationsRead(): void {
    this.metadata.markAllNotificationsRead();
  }

  savePushSubscription(
    record: Parameters<MetadataStore['savePushSubscription']>[0],
  ): void {
    this.metadata.savePushSubscription(record);
  }

  async close(): Promise<void> {
    await this.orchestrationService?.stop();
    await this.uploads.close();
    this.sessionIndex.close();
    this.eventStream.close();
    this.registry.close();
    this.notifications.close();
    this.metadata.close();
  }

  private async sessionsStart(): Promise<void> {
    // SessionIndex.start is intentionally kept behind the application boundary.
    await this.sessionIndex.start(this.workspaces.list());
  }
}

export type DashboardNotification = NotificationEvent;
