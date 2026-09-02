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
  type CheckoutSummary,
  type DelegateLiveRun,
  MAX_SHELL_INDEX_ITEMS,
  MAX_SHELL_SNAPSHOT_BYTES,
  MAX_TEXT,
  type NormalizedMessagePayload,
  type NormalizedToolPayload,
  type NotificationEvent,
  normalizeSessionTitle,
  PROTOCOL_VERSION,
  type ProjectSummary,
  type RunSummary,
  type RuntimeSnapshot,
  type RuntimeSnapshotPatch,
  type SessionIndexEntry,
  type SessionSnapshot,
  type ShellProjection,
  type ShellProjectionDomain,
  type ShellRuntimeSnapshot,
  type ShellUsage,
  type ThreadSummary,
  tryParseDelegateTranscriptEntry,
} from '@pi-dashboard/protocol';
import type { MetadataStore } from '../metadata.js';
import type { ProjectResolver } from '../project-resolver.js';
import type { PushSender } from '../push.js';
import type { SqliteOrchestrationRepository } from '../repositories/sqlite-orchestration-repository.js';
import type { RuntimeManager } from '../runtime-manager.js';
import type { RegistryChange, RuntimeRegistry } from '../runtime-registry.js';
import {
  deriveSessionBranchTopology,
  type SessionIndex,
} from '../session-index.js';
import type { UsageProvider } from '../usage.js';
import { NotificationService } from './notification-service.js';
import type { OrchestrationService } from './orchestration-service.js';
import { RuntimeService } from './runtime-service.js';
import { SessionService } from './session-service.js';
import type { SessionUsageService } from './session-usage-service.js';
import { UploadService } from './upload-service.js';
import { UsageService } from './usage-service.js';

export interface ApplicationChange {
  type: 'event' | 'snapshot';
  event?: BridgeEvent;
  runtimeId?: string;
  runtimeEpoch?: string;
  runtimeSeq?: number;
  sessionId?: string;
  snapshot?: RuntimeSnapshot;
}

export type InternalSessionSnapshot = AuthoritativeSessionSnapshot;

const ACTIVE_USAGE_FRESH_MS = 60_000;
const IDLE_USAGE_FRESH_MS = 20 * 60_000;

export interface DashboardApplicationOptions {
  registry: RuntimeRegistry;
  manager: RuntimeManager;
  sessions: SessionIndex;
  metadata: MetadataStore;
  usage: UsageProvider;
  sessionUsage?: SessionUsageService;
  push: PushSender;
  stateDir: string;
  onChange?: () => void;
  orchestration?: OrchestrationService;
  /** Resolves indexed sessions; runtime association stays in RuntimeRegistry. */
  projectResolver?: ProjectResolver;
}

export interface SessionMetadataDelta {
  readonly upsert: readonly SessionIndexEntry[];
  readonly remove: readonly string[];
}

const SESSION_METADATA_FIELDS = [
  'file',
  'cwd',
  'sessionKind',
  'parentSessionId',
  'projectId',
  'checkoutId',
  'name',
  'title',
  'lastKnownModel',
  'lastKnownThinking',
  'lastKnownContextTokens',
  'startedAt',
  'updatedAt',
  'activeRuntimeId',
  'entryCount',
] as const satisfies readonly (keyof SessionIndexEntry)[];

function sameSessionMetadata(
  left: SessionIndexEntry,
  right: SessionIndexEntry,
): boolean {
  return SESSION_METADATA_FIELDS.every((field) => {
    if (field !== 'lastKnownModel') return left[field] === right[field];
    return (
      left.lastKnownModel?.provider === right.lastKnownModel?.provider &&
      left.lastKnownModel?.model === right.lastKnownModel?.model
    );
  });
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

const SHELL_USAGE_BYTES = 64 * 1024;

/** The single usage projection used by shell snapshots and usage patches. */
export function projectShellUsage(value: unknown): ShellUsage | undefined {
  if (value === undefined) return undefined;
  const project = (input: unknown, depth: number): ShellUsage => {
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') return input.slice(0, MAX_TEXT);
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (depth <= 0) return null;
    if (Array.isArray(input)) {
      const result = input
        .slice(0, 128)
        .map((item) => project(item, depth - 1));
      try {
        return Buffer.byteLength(JSON.stringify(result), 'utf8') <=
          SHELL_USAGE_BYTES
          ? (result as ShellUsage)
          : { truncated: true };
      } catch {
        return { truncated: true };
      }
    }
    if (typeof input !== 'object') return null;
    const result: Record<string, ShellUsage> = {};
    for (const [key, item] of Object.entries(input).slice(0, 128))
      result[key.slice(0, 128)] = project(item, depth - 1);
    try {
      return Buffer.byteLength(JSON.stringify(result), 'utf8') <=
        SHELL_USAGE_BYTES
        ? (result as ShellUsage)
        : { truncated: true };
    } catch {
      return { truncated: true };
    }
  };
  const projected = project(value, 5);
  try {
    return Buffer.byteLength(JSON.stringify(projected), 'utf8') <=
      SHELL_USAGE_BYTES
      ? projected
      : { truncated: true };
  } catch {
    return { truncated: true };
  }
}

const MAX_SHELL_RUNTIME_BYTES = 256 * 1024;
const MAX_SHELL_CATALOGUE_BYTES = 350_000;
const SHELL_PROJECTION_DOMAINS = [
  'projects',
  'checkouts',
  'threads',
  'runs',
  'unread',
] as const satisfies readonly ShellProjectionDomain[];

export interface ShellProjectionResult {
  readonly shellProjection: ShellProjection;
  readonly runtimes: ShellRuntimeSnapshot[];
  readonly sessions: SessionIndexEntry[];
  readonly projects: ProjectSummary[];
  readonly checkouts: CheckoutSummary[];
  readonly threads: ThreadSummary[];
  readonly runs: RunSummary[];
  readonly unread: NotificationEvent[];
  readonly usage?: ShellUsage;
}

/** Compact runtime state shared by authoritative snapshots and shell patches. */
export function shellRuntime(
  runtime: RuntimeSnapshot,
  maxBytes = MAX_SHELL_RUNTIME_BYTES,
): RuntimeSnapshot {
  const compacted = compactPublicRuntime(runtime);
  let truncated = false;
  let extensionSurfaces = compacted.extensionSurfaces
    ?.slice(0, MAX_SHELL_SURFACES)
    .map((surface) => {
      const surfaceBytes = Buffer.byteLength(JSON.stringify(surface) ?? '');
      if (surfaceBytes <= MAX_SHELL_SURFACE_BYTES) return surface;
      truncated = true;
      return { ...surface, viewModel: { truncated: true } };
    });
  if ((compacted.extensionSurfaces?.length ?? 0) > MAX_SHELL_SURFACES)
    truncated = true;
  const makeResult = (): RuntimeSnapshot =>
    ({
      ...compacted,
      ...(extensionSurfaces === undefined ? {} : { extensionSurfaces }),
      ...(truncated ? { shellStateTruncated: true } : {}),
    }) as RuntimeSnapshot;
  while (Buffer.byteLength(JSON.stringify(makeResult()) ?? '') > maxBytes) {
    if (extensionSurfaces && extensionSurfaces.length > 0)
      extensionSurfaces = extensionSurfaces.slice(1);
    else {
      truncated = true;
      break;
    }
    truncated = true;
  }
  return makeResult();
}

/** Bound a catalogue for both a shell patch and a snapshot projection. */
export function projectShellArray<T>(
  values: readonly T[],
  maxBytes = 350_000,
): T[] {
  const result: T[] = [];
  let total = 2;
  for (const value of values) {
    if (result.length >= MAX_SHELL_INDEX_ITEMS) break;
    const itemBytes = Buffer.byteLength(JSON.stringify(value) ?? '');
    if (total + itemBytes > maxBytes) break;
    result.push(value);
    total += itemBytes + (result.length === 1 ? 0 : 1);
  }
  return result;
}

const MAX_ACTIVE_ENTITIES = 256;
const MAX_ACTIVE_BYTES = 512 * 1024;
const MAX_SHELL_SURFACE_BYTES = 64 * 1024;
const MAX_SHELL_SURFACES = 32;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,200}$/;

type ActiveTranscriptState = {
  runtimeId: string;
  runtimeEpoch: string;
  runtimeSeq: number;
  liveState: RuntimeSnapshot['liveState'];
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
  /** Captured synchronously with the active runtime/state before disk I/O. */
  runtimeEpoch?: string;
  runtimeSeq?: number;
};

function sameRuntimeCapture(
  left: ActiveCapture,
  right: ActiveCapture,
): boolean {
  return (
    left.runtime?.runtimeId === right.runtime?.runtimeId &&
    left.runtimeEpoch === right.runtimeEpoch &&
    left.runtimeSeq === right.runtimeSeq &&
    left.state?.runtimeEpoch === right.state?.runtimeEpoch &&
    left.state?.runtimeSeq === right.state?.runtimeSeq
  );
}

/**
 * A pinned disk read may intentionally return the old capture, but it must
 * never write that capture over a publication received while the read was
 * awaiting I/O. State identity catches changes even when a provider repeats a
 * runtime sequence number.
 */
function sameActiveCapture(left: ActiveCapture, right: ActiveCapture): boolean {
  return sameRuntimeCapture(left, right) && left.state === right.state;
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
      ...(typeof value.sessionId === 'string' && value.sessionId.length > 0
        ? { sessionId: value.sessionId }
        : {}),
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
      ...(Array.isArray(value.capabilities) &&
      value.capabilities.includes('web')
        ? { capabilities: ['web' as const] }
        : {}),
      ...(pauseState === 'pausing' || pauseState === 'paused'
        ? { pauseState }
        : {}),
      ...(typeof value.pausedAt === 'number'
        ? { pausedAt: value.pausedAt }
        : {}),
      ...(value.details && typeof value.details === 'object'
        ? { details: value.details as DelegateLiveRun['details'] }
        : {}),
      ...(value.workflow && typeof value.workflow === 'object'
        ? { workflow: value.workflow as DelegateLiveRun['workflow'] }
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

function terminalMessageKey(
  item: TranscriptItem | undefined,
): string | undefined {
  if (item?.kind !== 'message' || item.timestamp === undefined)
    return undefined;
  try {
    return JSON.stringify([item.role, item.timestamp, item.content]);
  } catch {
    return undefined;
  }
}

function persistedTerminalMessageCounts(
  projection: TranscriptProjection,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of Object.values(projection.items)) {
    const key = terminalMessageKey(item);
    if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function customMessageDedupeKey(value: unknown): string | undefined {
  const details = record(value);
  if (!details) return undefined;
  if (typeof details.dedupeKey === 'string' && details.dedupeKey.length > 0)
    return details.dedupeKey;

  // Compatibility for custom messages persisted before the shared contract.
  if (typeof details.deliveryKey === 'string' && details.deliveryKey.length > 0)
    return `delivery:${details.deliveryKey}`;
  if (typeof details.id === 'string' && details.id.length > 0)
    return `id:${details.id}`;
  if (!Array.isArray(details.jobs)) return undefined;
  const jobIds = details.jobs.flatMap((job) => {
    const id = record(job)?.id;
    return typeof id === 'string' && id.length > 0 ? [id] : [];
  });
  return jobIds.length > 0
    ? `jobs:${[...new Set(jobIds)].sort().join(',')}`
    : undefined;
}

function persistedCustomMessage(
  item: TranscriptItem,
): Record<string, unknown> | undefined {
  if (item.kind !== 'other') return undefined;
  const raw = record(item.raw);
  return raw?.type === 'custom_message' ? raw : undefined;
}

function samePersistedCustomMessage(
  active: Extract<TranscriptItem, { kind: 'message' }>,
  persisted: Record<string, unknown>,
): boolean {
  if (active.role !== 'custom') return false;
  const data = record(active.data);
  if (
    typeof persisted.customType !== 'string' ||
    persisted.customType !== data?.customType ||
    normalizedMessageContent(persisted.content) !==
      normalizedMessageContent(active.content)
  )
    return false;
  if (persisted.id === active.messageId) return true;
  const activeTimestamp = active.timestamp;
  const persistedTimestamp = persisted.timestamp;
  if (
    activeTimestamp !== undefined &&
    persistedTimestamp !== undefined &&
    String(activeTimestamp) === String(persistedTimestamp)
  )
    return true;
  const activeDedupeKey = customMessageDedupeKey(data?.details);
  return (
    activeDedupeKey !== undefined &&
    activeDedupeKey === customMessageDedupeKey(persisted.details)
  );
}

function normalizedMessageContent(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value)) ?? '';
}

/**
 * Remove only active message overlays already proven present in the persisted
 * branch. Timestamp-less messages are never guessed; equal timestamp/content
 * pairs must be unique so repeated messages cannot be accidentally retired.
 */
export function retirePersistedMessageOverlays(
  active: TranscriptProjection,
  persisted: TranscriptProjection,
): TranscriptProjection {
  const persistedItems = Object.values(persisted.items);
  const persistedMessages = persistedItems.filter(
    (item): item is Extract<TranscriptItem, { kind: 'message' }> =>
      item.kind === 'message',
  );
  const persistedCustomMessages = persistedItems.flatMap((item) => {
    const message = persistedCustomMessage(item);
    return message ? [message] : [];
  });
  const retire = new Set<string>();
  for (const id of active.order) {
    const item = active.items[id];
    if (item?.kind !== 'message') continue;
    const matchingCustomMessages = persistedCustomMessages.filter((candidate) =>
      samePersistedCustomMessage(item, candidate),
    );
    if (matchingCustomMessages.length === 1) {
      retire.add(id);
      continue;
    }
    const sameContent = (candidate: typeof item): boolean =>
      candidate.role === item.role &&
      normalizedMessageContent(candidate.content) ===
        normalizedMessageContent(item.content) &&
      (item.timestamp === undefined ||
        candidate.timestamp === undefined ||
        String(candidate.timestamp) === String(item.timestamp));
    const explicit = persistedMessages.filter(
      (candidate) =>
        candidate.messageId === item.messageId && sameContent(candidate),
    );
    if (explicit.length === 1) {
      retire.add(id);
      continue;
    }
    if (item.timestamp === undefined) continue;
    const semantic = persistedMessages.filter(
      (candidate) =>
        candidate.timestamp !== undefined &&
        String(candidate.timestamp) === String(item.timestamp) &&
        sameContent(candidate),
    );
    if (semantic.length === 1) retire.add(id);
  }
  if (retire.size === 0) return active;
  const items = { ...active.items };
  for (const id of retire) delete items[id];
  return {
    ...active,
    order: active.order.filter((id) => !retire.has(id)),
    items,
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
    ...(item.arguments !== undefined || item.argumentPreview === undefined
      ? {}
      : { argumentPreview: item.argumentPreview }),
    ...(item.arguments !== undefined || item.argumentChars === undefined
      ? {}
      : { argumentChars: item.argumentChars }),
    ...(item.arguments !== undefined || item.argumentLines === undefined
      ? {}
      : { argumentLines: item.argumentLines }),
    ...(item.result === undefined ? {} : { result: item.result }),
    ...(item.isError === undefined ? {} : { isError: item.isError }),
    ...(item.timestamp === undefined ? {} : { timestamp: item.timestamp }),
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
 * authority, while browser feeds only receive bounded metadata projections.
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
  readonly notifications: NotificationService;
  readonly usage: UsageService;
  readonly uploads: UploadService;
  private readonly registry: RuntimeRegistry;
  private readonly manager: RuntimeManager;
  private readonly metadata: MetadataStore;
  readonly orchestration: SqliteOrchestrationRepository;
  private readonly sessionIndex: SessionIndex;
  /** Metadata emitted by the last authoritative snapshot/index publication. */
  private sessionMetadataBaseline?: ReadonlyMap<string, SessionIndexEntry>;
  /** Bounded, process-local live transcript projection; never persisted. */
  private readonly activeTranscripts = new Map<string, ActiveTranscriptState>();
  private readonly dormantSessionAssociations = new Map<
    string,
    { cwd: string; projectId: string | null; checkoutId: string | null }
  >();
  private associationCatalogueSignature: string | undefined;
  readonly orchestrationService?: OrchestrationService;
  private readonly projectResolver?: ProjectResolver;

  constructor(options: DashboardApplicationOptions) {
    this.registry = options.registry;
    this.manager = options.manager;
    this.metadata = options.metadata;
    this.orchestration = options.metadata.orchestration;
    this.sessionIndex = options.sessions;
    this.orchestrationService = options.orchestration;
    this.projectResolver = options.projectResolver;
    this.runtime = new RuntimeService(
      options.registry,
      options.manager,
      options.sessions,
      options.metadata.orchestration,
      (threadId) => {
        options.orchestration?.noteThreadActivity(threadId);
        options.onChange?.();
      },
    );
    this.sessions = new SessionService(options.sessions);
    this.notifications = new NotificationService(
      options.metadata,
      options.push,
    );
    this.usage = new UsageService(options.usage, options.onChange, {
      history: options.metadata.usageHistory,
      sessionUsage: options.sessionUsage,
      freshMs: () =>
        this.runtime
          .snapshots()
          .some(
            (runtime) =>
              runtime.online !== false &&
              (runtime.liveState === 'working' ||
                runtime.liveState === 'compacting'),
          )
          ? ACTIVE_USAGE_FRESH_MS
          : IDLE_USAGE_FRESH_MS,
    });
    this.uploads = new UploadService(options.stateDir);
  }

  async start(): Promise<void> {
    await this.uploads.start();
    await this.sessionsStart();
    this.initializeSessionMetadataBaseline();
  }

  setPush(push: PushSender): void {
    this.notifications.setPush(push);
  }

  private sessionAssociation(
    session: Pick<SessionIndexEntry, 'id' | 'cwd'>,
    runtime?: RuntimeSnapshot,
    persistedAssociation?: {
      projectId: string;
      checkoutId: string;
    } | null,
  ): Pick<SessionIndexEntry, 'projectId' | 'checkoutId'> {
    if (runtime)
      return {
        projectId: runtime.projectId ?? null,
        checkoutId: runtime.checkoutId ?? null,
      };
    if (persistedAssociation)
      return {
        projectId: persistedAssociation.projectId,
        checkoutId: persistedAssociation.checkoutId,
      };
    if (persistedAssociation === undefined) {
      const persistedRun = this.orchestration.getRunByPiSessionId(session.id);
      const persistedThread = persistedRun
        ? this.orchestration.getThread(persistedRun.threadId)
        : undefined;
      if (persistedRun && persistedThread)
        return {
          projectId: persistedThread.projectId,
          checkoutId:
            persistedRun.checkoutId ?? persistedThread.checkoutId ?? null,
        };
    }
    const cached = this.dormantSessionAssociations.get(session.id);
    if (cached?.cwd === session.cwd)
      return {
        projectId: cached.projectId,
        checkoutId: cached.checkoutId,
      };
    const resolved = this.projectResolver?.resolve(session.cwd) ?? {
      projectId: null,
      checkoutId: null,
    };
    this.dormantSessionAssociations.set(session.id, {
      cwd: session.cwd,
      ...resolved,
    });
    return resolved;
  }

  private refreshAssociationCatalogue(): void {
    const signature = JSON.stringify({
      projects: this.orchestration.projectSummaries(),
      checkouts: this.orchestration.checkoutSummaries(),
    });
    if (signature === this.associationCatalogueSignature) return;
    this.associationCatalogueSignature = signature;
    this.dormantSessionAssociations.clear();
  }

  /** Authoritative session metadata, including live runtime overlays. */
  sessionMetadata(
    liveRuntimes = this.registry.snapshots(),
  ): SessionIndexEntry[] {
    this.refreshAssociationCatalogue();
    const activeRuntimes = new Map(
      liveRuntimes
        .filter((runtime) => runtime.online !== false)
        .map((runtime) => [runtime.session.id, runtime]),
    );
    const persistedAssociations = this.orchestration.sessionRunAssociations();
    return this.sessions
      .list()
      .map((session) =>
        this.sessionMetadataEntry(
          session,
          activeRuntimes.get(session.id),
          persistedAssociations.get(session.id) ?? null,
        ),
      );
  }

  private sessionMetadataEntry(
    session: SessionIndexEntry,
    runtime?: RuntimeSnapshot,
    persistedAssociation?: {
      projectId: string;
      checkoutId: string;
    } | null,
  ): SessionIndexEntry {
    const association = this.sessionAssociation(
      session,
      runtime,
      persistedAssociation,
    );
    const runtimeTitle =
      runtime?.session.title === undefined
        ? undefined
        : normalizeSessionTitle(runtime.session.title);
    return {
      ...session,
      ...association,
      ...(runtime?.session.name !== undefined
        ? { name: runtime.session.name }
        : {}),
      ...(runtimeTitle === undefined ? {} : { title: runtimeTitle }),
      activeRuntimeId: runtime?.runtimeId,
    };
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

  /** Compare only the session affected by one registry change. */
  sessionMetadataDeltaForSession(
    sessionId: string,
  ): SessionMetadataDelta | undefined {
    const prior = this.sessionMetadataBaseline;
    if (!prior) return undefined;
    this.refreshAssociationCatalogue();
    const indexed = this.sessionIndex
      .list()
      .find((session) => session.id === sessionId);
    const runtime = this.registry
      .snapshots()
      .find((item) => item.session.id === sessionId && item.online !== false);
    const current = indexed
      ? this.sessionMetadataEntry(indexed, runtime)
      : undefined;
    const next = new Map(prior);
    if (current) next.set(sessionId, current);
    else next.delete(sessionId);
    this.sessionMetadataBaseline = next;
    const previous = prior.get(sessionId);
    if (!current)
      return previous === undefined
        ? undefined
        : { upsert: [], remove: [sessionId] };
    if (previous && sameSessionMetadata(previous, current)) return undefined;
    return { upsert: [current], remove: [] };
  }

  /** Cheap change detector for shell catalogues that excludes session work. */
  applicationDomainSignature(): string {
    return JSON.stringify({
      projects: this.orchestration.projectSummaries(),
      checkouts: this.orchestration.checkoutSummaries(),
      threads: this.orchestration.threadSummaries(),
      runs: this.orchestration.runSummaries(),
      usage: this.usage.cached(),
      unread: this.metadata.unreadNotifications(),
    });
  }

  /**
   * Build the one bounded shell projection used by snapshots and every shell
   * catalogue patch. The source arrays are read once and then trimmed in a
   * fixed order, so a reconnect cannot silently describe different entities
   * from the live feed.
   */
  shellProjection(): ShellProjectionResult {
    const liveRuntimes = this.registry.snapshots();
    const sessions = this.sessionMetadata(liveRuntimes);
    if (sessions.length > MAX_SHELL_INDEX_ITEMS)
      throw new Error(
        'The authoritative session index exceeds shell capacity.',
      );
    this.setSessionMetadataBaseline(sessions);
    let runtimes = liveRuntimes.map(
      (runtime) => shellRuntime(runtime) as ShellRuntimeSnapshot,
    );
    const omitted = new Set<ShellProjectionDomain>();
    const catalogue = <T>(
      domain: ShellProjectionDomain,
      values: readonly T[],
    ): T[] => {
      const projected = projectShellArray(values, MAX_SHELL_CATALOGUE_BYTES);
      if (projected.length !== values.length) omitted.add(domain);
      return projected;
    };
    const projects = catalogue(
      'projects',
      this.orchestration.projectSummaries(),
    );
    const checkouts = catalogue(
      'checkouts',
      this.orchestration.checkoutSummaries(),
    );
    const threads = catalogue('threads', this.orchestration.threadSummaries());
    const runs = catalogue('runs', this.orchestration.runSummaries());
    const unread = catalogue('unread', this.metadata.unreadNotifications());
    const usage = projectShellUsage(this.usage.cached());
    const makeMarker = (): ShellProjection => ({
      truncated: omitted.size > 0,
      omitted: SHELL_PROJECTION_DOMAINS.filter((domain) => omitted.has(domain)),
    });
    const makeSnapshot = (): BrowserSnapshot => ({
      // Reserve the largest transport metadata representation because this
      // projection is reused by callers with different daemon cursors.
      serverId: 's'.repeat(512),
      revision: Number.MAX_SAFE_INTEGER,
      cursor: Number.MAX_SAFE_INTEGER,
      runtimes,
      projects,
      checkouts,
      threads,
      runs,
      sessions,
      ...(usage === undefined ? {} : { usage }),
      unread,
      shellProjection: makeMarker(),
    });
    const setCollections = [
      { domain: 'unread' as const, items: unread },
      { domain: 'runs' as const, items: runs },
      { domain: 'threads' as const, items: threads },
      { domain: 'checkouts' as const, items: checkouts },
      { domain: 'projects' as const, items: projects },
    ];
    while (
      Buffer.byteLength(JSON.stringify(makeSnapshot()) ?? '') >
      MAX_SHELL_SNAPSHOT_BYTES
    ) {
      const collection = setCollections.find(({ items }) => items.length > 0);
      if (!collection) break;
      collection.items.pop();
      omitted.add(collection.domain);
    }
    // A large runtime is compacted further before it can make reconnects fail.
    if (
      Buffer.byteLength(JSON.stringify(makeSnapshot()) ?? '') >
      MAX_SHELL_SNAPSHOT_BYTES
    )
      runtimes = liveRuntimes.map(
        (runtime) => shellRuntime(runtime, 8 * 1024) as ShellRuntimeSnapshot,
      );
    if (
      Buffer.byteLength(JSON.stringify(makeSnapshot()) ?? '') >
      MAX_SHELL_SNAPSHOT_BYTES
    )
      throw new Error(
        'The authoritative shell snapshot exceeds its frame limit.',
      );
    return {
      shellProjection: makeMarker(),
      runtimes,
      sessions,
      projects,
      checkouts,
      threads,
      runs,
      unread,
      ...(usage === undefined ? {} : { usage }),
    };
  }

  /** Build a shell snapshot synchronously from one daemon cursor. */
  shellSnapshot(
    serverId: string,
    revision: number,
    cursor = 0,
  ): BrowserSnapshot {
    const projection = this.shellProjection();
    return {
      serverId,
      revision,
      cursor,
      runtimes: projection.runtimes,
      projects: projection.projects,
      checkouts: projection.checkouts,
      threads: projection.threads,
      runs: projection.runs,
      sessions: projection.sessions,
      ...(projection.usage === undefined ? {} : { usage: projection.usage }),
      unread: projection.unread,
      shellProjection: projection.shellProjection,
    };
  }

  /** Build a full snapshot at an explicitly pinned feed sequence. */
  snapshot(serverId: string, revision: number, cursor = 0): BrowserSnapshot {
    // Keep the full session snapshot shape independent of the compact shell
    // projection; callers supply the owning feed sequence explicitly.
    const liveRuntimes = this.registry.snapshots();
    const sessions = this.sessionMetadata(liveRuntimes);
    this.setSessionMetadataBaseline(sessions);
    return {
      serverId,
      revision,
      cursor,
      runtimes: liveRuntimes.map((runtime) => compactPublicRuntime(runtime)),
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
    if (change.kind === 'offline' || change.kind === 'removed') {
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
    // Provenance is part of the same synchronous cut as the runtime/state.
    // Never look it up again after session-index I/O for a pinned snapshot.
    const provenance = runtime
      ? this.registry.transportProvenance(runtime.runtimeId)
      : undefined;
    return {
      runtime,
      state,
      runtimeEpoch: state?.runtimeEpoch ?? provenance?.runtimeEpoch,
      runtimeSeq: state?.runtimeSeq ?? provenance?.runtimeSeq,
    };
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
    const delegateProjection = runtime
      ? activeDelegateRuns(runtime)
      : { runs: [], truncated: false };
    let delegates = delegateProjection.runs;
    let truncated =
      (state?.truncated ?? false) ||
      (state?.uncertain ?? false) ||
      unresolved.size > 0 ||
      delegateProjection.truncated;
    const bytes = (value: unknown): number =>
      Buffer.byteLength(JSON.stringify(value) ?? '');
    while (
      bytes({ messages, tools, delegates }) > MAX_ACTIVE_BYTES &&
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
    feedSequence?: number,
  ): Promise<InternalSessionSnapshot> {
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
      const activeLeafId = runtimeLeafId(runtime);
      return {
        metadata: runtimeMetadata(runtime, indexed),
        entries: [...entries],
        entriesComplete: complete,
        branchTopology: deriveSessionBranchTopology(entries, activeLeafId),
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
      const cursor = feedSequence ?? 0;
      const capture = before === undefined ? this.captureActive(sessionId) : {};
      const indexed = this.sessionIndex.get(sessionId);
      let result: SessionRead;
      try {
        if (!indexed && capture.runtime) {
          result = boundedRuntimeRead(capture.runtime, indexed);
        } else {
          const liveLeafId =
            before === undefined ? runtimeLeafId(capture.runtime) : undefined;
          result = await this.sessionIndex.readEntries(
            sessionId,
            before,
            liveLeafId,
            {
              resolveLatestLeaf:
                before === undefined &&
                runtimeIsWorking(capture.runtime) &&
                liveLeafId === undefined,
            },
          );
        }
      } catch (error) {
        if (!capture.runtime || before !== undefined) throw error;
        result = boundedRuntimeRead(capture.runtime, indexed);
      }
      if (
        before === undefined &&
        feedSequence === undefined &&
        !sameRuntimeCapture(capture, this.captureActive(sessionId))
      )
        continue;
      let resolvedCapture = capture;
      if (before === undefined && capture.state) {
        const persisted = hydrateTranscript(result.entries, sessionId);
        const reconciledProjection = retirePersistedMessageOverlays(
          capture.state.projection,
          persisted,
        );
        const reconciledState = {
          ...capture.state,
          projection: reconciledProjection,
        };
        const persistedIds = new Set(Object.keys(persisted.items));
        const persistedMessageCounts =
          persistedTerminalMessageCounts(persisted);
        const unresolvedTerminalIds =
          reconciledState.unresolvedTerminalIds.filter((id) => {
            if (!reconciledState.projection.items[id]) return false;
            if (persistedIds.has(id)) return false;
            const key = terminalMessageKey(
              reconciledState.projection.items[id],
            );
            return key === undefined || persistedMessageCounts.get(key) !== 1;
          });
        const fullyProved =
          result.entriesComplete &&
          unresolvedTerminalIds.length === 0 &&
          !runtimeIsWorking(capture.runtime);
        const state = {
          ...reconciledState,
          unresolvedTerminalIds,
          uncertain: fullyProved ? false : reconciledState.uncertain,
        };
        // `feedSequence` pins the response and deliberately skips the normal
        // retry, so the active map may have advanced while disk I/O awaited.
        // Never let this old reconciliation erase that newer publication.
        if (sameActiveCapture(capture, this.captureActive(sessionId)))
          this.activeTranscripts.set(sessionId, state);
        // The response still uses its pinned, reconciled capture even when a
        // newer publication won the race; only the process-global map is
        // protected from the stale write above.
        resolvedCapture = { ...capture, state };
      }
      const active =
        before === undefined
          ? this.activeOverlay(resolvedCapture)
          : this.activeOverlay({});
      // `resolvedCapture` is the pinned synchronous cut. In particular, do not
      // query the registry here: a deferred publication may have advanced its
      // provenance while the disk read was awaiting I/O.
      const runtimeEpoch =
        resolvedCapture.runtimeEpoch ?? resolvedCapture.state?.runtimeEpoch;
      const runtimeSeq =
        resolvedCapture.runtimeSeq ?? resolvedCapture.state?.runtimeSeq;
      const baseMetadata = resolvedCapture.runtime
        ? runtimeMetadata(resolvedCapture.runtime, result.metadata)
        : result.metadata;
      const metadata = {
        ...baseMetadata,
        ...this.sessionAssociation(baseMetadata, resolvedCapture.runtime),
      };
      // `result` retains the read's provenance: indexed topology for a
      // persisted branch, or runtime-only topology when the live leaf is not
      // persisted yet. Do not replace it with a second indexed lookup.
      const branchTopology = result.branchTopology;
      const completeThroughCursor =
        before === undefined &&
        result.entriesComplete &&
        !active.truncated &&
        (!resolvedCapture.runtime || resolvedCapture.state !== undefined);
      return {
        metadata,
        entries: result.entries,
        ...(result.outline === undefined
          ? {}
          : { outline: [...result.outline] }),
        ...(branchTopology === undefined ? {} : { branchTopology }),
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
    if (
      change.kind === 'event' &&
      change.event.type === 'runtime.stateChanged' &&
      change.event.state === 'working'
    )
      this.runtime.activateSession(
        change.snapshot.session.id,
        `${change.runtimeId}-${change.runtimeEpoch ?? 'epoch'}-${change.runtimeSeq ?? Date.now()}`,
      );
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
    if (change.kind === 'removed')
      return {
        type: 'event',
        event: { type: 'runtime.goodbye', reason: 'stopped' },
        runtimeId: change.snapshot.runtimeId,
        sessionId: change.snapshot.session.id,
        ...provenance,
      };
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
    this.registry.close();
    this.notifications.close();
    this.metadata.close();
  }

  private async sessionsStart(): Promise<void> {
    // SessionIndex.start is intentionally kept behind the application boundary.
    await this.sessionIndex.start();
  }
}

export type DashboardNotification = NotificationEvent;
