import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type http from 'node:http';
import {
  delegateHistoryFromBranch,
  delegateHistoryRunDetailFromBranch,
  isDelegateHistoryEntry,
  isPersistedSteeringMarker,
  persistedEntriesToTranscriptEvents,
  projectDelegateHistoryEntry,
} from '@pi-dashboard/domain';
import {
  type ActiveDelegateTranscriptBaseline,
  type BridgeCommand,
  type BridgeEvent,
  type BrowserSnapshot,
  type DelegateHistoryResponse,
  type DelegateHistoryRunDetailResponse,
  type DelegateHistoryRunQuery,
  type DelegateLiveRun,
  MAX_FRAME_BYTES,
  MAX_ID,
  MAX_SESSION_INDEX_DELTA_ITEMS,
  MAX_SHELL_INDEX_ITEMS,
  MAX_SHELL_SNAPSHOT_BYTES,
  PROTOCOL_VERSION,
  type RuntimeSnapshot,
  type ShellFeedData,
  type ShellFeedDomain,
  type ShellRuntimeSnapshot,
  tryParseActiveDelegateTranscriptBaseline,
  tryParseDelegateTranscriptEntry,
  validateBridgeCommand,
  validateSessionRenameRequest,
  type WorkspaceTarget,
} from '@pi-dashboard/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  projectPublicBridgeEvent,
  type SessionMetadataDelta,
  shellRuntime,
} from './application/dashboard-application.js';
import type {
  DashboardDependencies,
  DashboardServerOptions,
} from './composition.js';
import { BridgeListener } from './http/bridge-listener.js';
import {
  compactShellEventData,
  MAX_SESSION_FEEDS,
  type SessionFeedRegistry,
  type ShellFeed,
  shellDomainForEvent,
} from './live-feeds.js';
import { createPushSender } from './push.js';
import { type DashboardRouteContext, dashboardRoutes } from './routes.js';
import type { RegistryChange } from './runtime-registry.js';
import {
  AuxiliaryAppendError,
  type AuxiliarySourceCursor,
} from './session-index.js';

/** Keep session deltas comfortably below the authoritative frame limit. */
const MAX_SESSION_INDEX_DELTA_BYTES = 1_500_000;

function shellRuntimeComparison(
  runtime: ShellRuntimeSnapshot,
  suppressHeartbeat: boolean,
): unknown {
  if (!suppressHeartbeat) return runtime;
  const { lastSeenAt: _lastSeenAt, ...stable } = runtime;
  return stable;
}

function transcriptOnlyShellEvent(event: BridgeEvent): boolean {
  switch (event.type) {
    case 'message.started':
    case 'message.updated':
    case 'message.finished':
    case 'tool.started':
    case 'tool.updated':
    case 'tool.finished':
    case 'delegate.transcript.updated':
    case 'session.changed':
    case 'session.snapshot':
    case 'session.compacted':
      return true;
    default:
      return false;
  }
}

function validDelegateIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function activeDelegateTranscriptBaseline(
  serverId: string,
  cursor: number,
  sessionId: string,
  runtime: RuntimeSnapshot | undefined,
  provenance?: { runtimeEpoch: string; runtimeSeq: number },
): ActiveDelegateTranscriptBaseline {
  const base = {
    version: 1 as const,
    serverId,
    cursor,
    sessionId,
    ...(runtime ? { runtimeId: runtime.runtimeId } : {}),
    ...(provenance ? { runtimeEpoch: provenance.runtimeEpoch } : {}),
    ...(provenance && provenance.runtimeSeq >= 0
      ? { runtimeSeq: provenance.runtimeSeq }
      : {}),
    runs: [] as DelegateLiveRun[],
  };
  if (!runtime || runtime.online === false) return base;
  const surfaces = runtime.extensionSurfaces ?? [];
  const delegateSurface = surfaces.find(
    (surface) => surface.rendererId === 'delegate.status',
  );
  const model = delegateSurface?.viewModel;
  const statuses =
    model && typeof model === 'object' && !Array.isArray(model)
      ? (model as { statuses?: unknown }).statuses
      : undefined;
  const runs: DelegateLiveRun[] = [];
  if (Array.isArray(statuses)) {
    for (const status of statuses.slice(0, 64)) {
      if (!status || typeof status !== 'object' || Array.isArray(status))
        continue;
      const value = status as Record<string, unknown>;
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
        typeof value.kind !== 'string' ||
        typeof value.createdAt !== 'number' ||
        !Number.isFinite(value.createdAt) ||
        typeof value.allowWrites !== 'boolean'
      )
        continue;
      const transcript = Array.isArray(value.transcript)
        ? value.transcript.flatMap((entry) => {
            const parsed = tryParseDelegateTranscriptEntry(entry);
            return parsed ? [parsed] : [];
          })
        : [];
      runs.push({
        runId: value.runId,
        ...(validDelegateIdentifier(value.sessionId)
          ? { sessionId: value.sessionId }
          : {}),
        lineageId: value.lineageId,
        name: value.name,
        kind: value.kind as DelegateLiveRun['kind'],
        state: state as DelegateLiveRun['state'],
        createdAt: value.createdAt,
        ...(typeof value.startedAt === 'number'
          ? { startedAt: value.startedAt }
          : {}),
        ...(typeof value.finishedAt === 'number'
          ? { finishedAt: value.finishedAt }
          : {}),
        ...(typeof value.jobId === 'string' ? { jobId: value.jobId } : {}),
        ...(typeof value.route === 'string' ? { route: value.route } : {}),
        ...(typeof value.context === 'string'
          ? { context: value.context as DelegateLiveRun['context'] }
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
  }
  const result = {
    ...base,
    runs,
  };
  return tryParseActiveDelegateTranscriptBaseline(result) ?? base;
}

function sessionEventCoalesceKey(event: BridgeEvent): string | undefined {
  if (event.type === 'delegate.transcript.updated')
    return `delegate:${event.runId}`;
  if (event.type === 'message.updated' || event.type === 'message.finished') {
    const message = event.message;
    return typeof message === 'object' && message !== null
      ? `message:${String((message as { messageId?: unknown }).messageId ?? '')}`
      : undefined;
  }
  if (event.type === 'tool.updated' || event.type === 'tool.finished') {
    const tool = event.tool;
    return typeof tool === 'object' && tool !== null
      ? `tool:${String((tool as { toolCallId?: unknown }).toolCallId ?? '')}`
      : undefined;
  }
  return undefined;
}

interface AuxiliaryFeedState {
  cursor?: AuxiliarySourceCursor;
  /** A marker at a bounded-range edge is carried into the next range only. */
  pendingSteeringMarkers: readonly unknown[];
  dirty: boolean;
  workerRunning: boolean;
  gateBusy: boolean;
  gateWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>;
  lastUsedAt: number;
}

const MAX_AUXILIARY_FEED_STATES = MAX_SESSION_FEEDS;
const MAX_AUXILIARY_GATE_WAITERS = 128;

export interface DashboardServer {
  readonly token: string;
  readonly socketPath: string;
  readonly port: number;
  readonly registry: DashboardDependencies['registry'];
  readonly manager: DashboardDependencies['manager'];
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): BrowserSnapshot;
  refreshWorkspaces(): Promise<WorkspaceTarget[]>;
  publishChange(message?: unknown): void;
  publishSessionIndexChange(sessionId?: string, auxiliary?: boolean): void;
}

/**
 * Thin Fastify lifecycle owner. The Unix bridge remains separate from the
 * browser feed protocol.
 */
export class DashboardServerImpl implements DashboardServer {
  readonly token: string;
  readonly socketPath: string;
  readonly registry: DashboardDependencies['registry'];
  readonly manager: DashboardDependencies['manager'];
  port: number;
  private readonly host: string;
  private readonly origins: string[];
  private readonly stateDir: string;
  private readonly configuration: DashboardDependencies['configuration'];
  private readonly metadata: DashboardDependencies['metadata'];
  private readonly sessions: DashboardDependencies['sessions'];
  private readonly pushConfigured: boolean;
  private push: DashboardDependencies['push'];
  private readonly app: FastifyInstance;
  private readonly http: http.Server;
  private readonly bridge: BridgeListener;
  private readonly shellFeed: ShellFeed;
  private readonly sessionFeeds: SessionFeedRegistry;
  private readonly application: DashboardDependencies['application'];
  private readonly runtimeProvider: DashboardDependencies['runtimeProvider'];
  private workspaces: WorkspaceTarget[] = [];
  private readonly serverId = randomBytes(12).toString('base64url');
  private revision = 0;
  private lifecycle: 'stopped' | 'starting' | 'started' | 'stopping' =
    'stopped';
  private httpHasStarted = false;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private feedSweepTimer: NodeJS.Timeout | undefined;
  /** Last concrete shell state sent for each independently coalesced patch. */
  private readonly shellPatchSignatures = new Map<string, string>();
  /** Runtime signatures retain both heartbeat recency and stable shell state. */
  private readonly shellRuntimeSignatures = new Map<
    string,
    { stable: string; full: string }
  >();
  private readonly auxiliaryFeeds = new Map<string, AuxiliaryFeedState>();

  constructor(dependencies: DashboardDependencies) {
    const config = dependencies.configuration;
    this.host = config.host;
    this.port = config.port;
    this.stateDir = config.stateDir;
    this.configuration = config;
    this.token = config.token;
    this.socketPath = config.socketPath;
    this.metadata = dependencies.metadata;
    this.sessions = dependencies.sessions;
    this.pushConfigured = dependencies.pushConfigured;
    this.push = dependencies.push;
    this.registry = dependencies.registry;
    this.manager = dependencies.manager;
    this.shellFeed = dependencies.shellFeed;
    this.sessionFeeds = dependencies.sessionFeeds;
    this.application = dependencies.application;
    this.runtimeProvider = dependencies.runtimeProvider;
    this.origins = config.origins;

    this.bridge = new BridgeListener((socket) => this.registry.accept(socket));

    this.app = Fastify({
      logger: false,
      // Reject, rather than silently strip, bounded orchestration command
      // properties at the HTTP boundary.
      ajv: { customOptions: { removeAdditional: false } },
    });
    this.app.register(dashboardRoutes, { context: this.routeContext() });
    this.http = this.app.server;
  }

  private routeContext(): DashboardRouteContext {
    return {
      token: this.token,
      serverId: () => this.serverId,
      origins: () => this.origins,
      snapshot: () =>
        this.application.snapshot(
          this.serverId,
          this.revision,
          this.shellFeed.sequence,
        ),
      shellSnapshot: () => {
        const snapshot = this.application.shellSnapshot(
          this.serverId,
          this.revision,
          this.shellFeed.sequence,
        );
        return { snapshot, cursor: snapshot.cursor };
      },
      sessionSnapshot: (id, before) =>
        this.buildSessionSnapshot(
          id,
          before,
          this.sessionFeeds.get(id).sequence,
        ),
      shellFeed: this.shellFeed,
      sessionFeeds: this.sessionFeeds,
      shellSnapshotAt: (sequence) => {
        const snapshot = this.application.shellSnapshot(
          this.serverId,
          this.revision,
          sequence,
        );
        return { snapshot, cursor: sequence };
      },
      sessionSnapshotAt: (id, sequence) =>
        this.buildSessionSnapshot(id, undefined, sequence),
      workspaces: () => this.application.workspaces.list(),
      refreshWorkspaces: () => this.refreshWorkspaces(),
      composerCommands: (workspaceId) =>
        this.application.composerCommands.forWorkspace(
          workspaceId,
          this.application.workspaces.list(),
        ),
      usage: () => this.application.usage.get(),
      readActiveDelegateTranscripts: (id) =>
        this.activeDelegateTranscriptResult(id),
      readDelegateHistory: (id) => this.delegateHistoryResult(id),
      readDelegateHistoryRun: (id, runId, query) =>
        this.delegateHistoryRunResult(id, runId, query),
      renameSession: async (id, name) => {
        if (!/^[a-zA-Z0-9._-]{1,200}$/.test(id))
          throw new Error('Invalid session id.');
        const { name: safeName } = validateSessionRenameRequest({ name });
        const runtime = this.registry
          .snapshots()
          .find((item) => item.session.id === id && item.online !== false);
        if (runtime) {
          const result = await this.application.runtime.renameSession(
            id,
            safeName,
          );
          this.changed();
          return { result };
        }
        const metadata = await this.application.runtime.renameSession(
          id,
          safeName,
        );
        this.changed();
        return { metadata };
      },
      startRuntime: async (input) => {
        const result = await this.application.runtime.launch(input);
        this.changed();
        return result;
      },
      restartRuntime: async (runtimeId, commandId) => {
        const result = await this.application.runtime.restartWithReceipt({
          runtimeId,
          commandId,
        });
        if (result.status === 'completed') this.changed();
        return result;
      },
      runtimeCommand: async (runtimeId: string, command: BridgeCommand) =>
        this.application.runtime.commandWithReceipt(runtimeId, command),
      startRuntimeMutation: async (input: unknown) => {
        const result = await this.application.runtime.startWithReceipt(input);
        if (result.status === 'completed') this.changed();
        return result;
      },
      restartRuntimeMutation: async (input: unknown) => {
        const result = await this.application.runtime.restartWithReceipt(input);
        if (result.status === 'completed') this.changed();
        return result;
      },
      stopRuntimeMutation: async (input: unknown) => {
        const result = await this.application.runtime.stopWithReceipt(input);
        if (result.status === 'completed') this.changed();
        return result;
      },
      renameSessionMutation: async (input: unknown) => {
        const result = await this.application.runtime.renameWithReceipt(input);
        if (result.status === 'completed') this.changed();
        return result;
      },
      commandRuntime: async (runtimeId, input, imageBuffers) => {
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new Error('Invalid command body.');
        const body = input as Record<string, unknown>;
        if ('images' in body)
          throw new Error('Image paths cannot be supplied by browser clients.');
        const images =
          imageBuffers.length > 0
            ? await this.application.uploads.save(imageBuffers)
            : [];
        try {
          if (
            imageBuffers.length > 0 &&
            this.registry.get(runtimeId)?.model?.supportsImages !== true
          )
            throw new Error(
              'This runtime does not support dashboard image attachments; reload it and select an image-capable model.',
            );
          const command = validateBridgeCommand({
            ...body,
            id:
              typeof body.id === 'string' && body.id.length > 0
                ? body.id
                : randomBytes(16).toString('hex'),
            ...(images.length > 0 ? { images } : {}),
          });
          return await this.application.runtime.command(runtimeId, command);
        } finally {
          await this.application.uploads.cleanup(
            images.map((image) => image.path),
          );
        }
      },
      stopRuntime: async (runtimeId, force) => {
        await this.application.runtime.stop(runtimeId, force);
        this.changed();
      },
      interaction: (id, answer, cancel) =>
        this.application.runtime.answerInteraction(id, answer, cancel),
      markNotificationRead: (id) => {
        this.application.markNotificationRead(id);
        this.changed();
      },
      markAllNotificationsRead: () => {
        this.application.markAllNotificationsRead();
        this.changed();
      },
      pushSubscribe: (body) => this.savePushSubscription(body),
      vapidPublicKey: () => process.env.PI_DASHBOARD_VAPID_PUBLIC_KEY ?? null,
      adoptProject: (command) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.adoptProject(
          command as Parameters<typeof service.adoptProject>[0],
        );
      },
      createThread: (projectId, command) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.createThread(
          projectId,
          command as Parameters<typeof service.createThread>[1],
        );
      },
      adoptSession: (projectId, sessionId, command) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.adoptSession(
          projectId,
          sessionId,
          command as Parameters<typeof service.adoptSession>[2],
        );
      },
      retryRun: (threadId, command) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.retryRun(
          threadId,
          command as Parameters<typeof service.retryRun>[1],
        );
      },
      cancelRun: (runId, commandId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.cancelRun(runId, commandId);
      },
      reviewCheckout: (checkoutId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.reviewCheckout(checkoutId);
      },
      mergeCheckout: (checkoutId, commandId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.mergeCheckout(checkoutId, commandId);
      },
      retireCheckout: (checkoutId, commandId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.retireCheckout(checkoutId, commandId);
      },
      archiveThread: (threadId, commandId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.archiveThread(threadId, commandId);
      },
      restoreThread: (threadId, commandId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.restoreThread(threadId, commandId);
      },
      pinThread: (threadId, commandId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.pinThread(threadId, commandId);
      },
      unpinThread: (threadId, commandId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.unpinThread(threadId, commandId);
      },
      listThreads: (projectId) =>
        this.application.orchestration.listThreads(projectId),
      sessionThreadLinks: () =>
        this.application.orchestration.sessionThreadLinks(),
      readThread: (threadId) => {
        const thread = this.application.orchestration.getThread(threadId);
        if (!thread) throw new Error(`Thread ${threadId} does not exist.`);
        return thread;
      },
    };
  }

  async start(): Promise<void> {
    if (this.lifecycle === 'started') return;
    if (this.lifecycle === 'starting') {
      await this.startPromise;
      return;
    }
    if (this.lifecycle === 'stopping') {
      await this.stopPromise;
      return this.start();
    }
    this.lifecycle = 'starting';
    const startup = this.startInternal();
    this.startPromise = startup;
    try {
      await startup;
    } finally {
      if (this.startPromise === startup) this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    try {
      await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      await this.application.uploads.start();
      await this.bridge.listen(this.socketPath);
      // Keep the HTTP boundary closed until the initial workspace refresh and
      // session index startup (including watcher installation) are complete.
      // refreshWorkspaces performs the first scan; start performs the second
      // scan before installing watchers, avoiding a scan-to-watcher gap.
      await this.refreshWorkspaces();
      await this.sessions.start(this.workspaces);
      // Every indexed ordinary session gets its exact durable link before the
      // HTTP listener opens. The repository sorts and makes this idempotent.
      this.application.orchestrationService?.ensureSessionThreadLinks(
        this.sessions.list(),
      );
      if (this.httpHasStarted) await this.listenHttp();
      else {
        await this.app.listen({ port: this.port, host: this.host });
        this.httpHasStarted = true;
      }
      const address = this.http.address();
      if (address && typeof address === 'object') this.port = address.port;
      for (const origin of [
        `http://${this.host}:${this.port}`,
        `http://localhost:${this.port}`,
      ]) {
        if (!this.origins.includes(origin)) this.origins.push(origin);
      }
      // Seed metadata before the file watcher is allowed to publish deltas.
      this.application.initializeSessionMetadataBaseline();
      await this.application.orchestrationService?.start();
      if (!this.pushConfigured)
        this.push = await createPushSender(this.metadata);
      this.application.setPush(this.push);
      this.feedSweepTimer = setInterval(
        () => {
          const now = Date.now();
          this.sessionFeeds.sweep(now, this.configuration.feedInactivityMs);
          for (const [sessionId, state] of this.auxiliaryFeeds) {
            const feed = this.sessionFeeds.peek(sessionId);
            if (
              !state.gateBusy &&
              !state.workerRunning &&
              (feed?.active ?? false) === false &&
              (feed?.metrics().subscribers ?? 0) === 0 &&
              now - state.lastUsedAt >= this.configuration.feedInactivityMs
            )
              this.auxiliaryFeeds.delete(sessionId);
          }
        },
        Math.max(
          30_000,
          Math.min(this.configuration.feedInactivityMs, 5 * 60_000),
        ),
      );
      this.feedSweepTimer.unref();
      this.lifecycle = 'started';
      // The first subscription snapshot is authoritative. Seed runtime patch
      // signatures so transcript-only callbacks cannot echo the same runtime.
      for (const runtime of this.registry.snapshots()) {
        const compacted = shellRuntime(runtime) as ShellRuntimeSnapshot;
        const stable = JSON.stringify({
          kind: 'upsert',
          runtime: shellRuntimeComparison(compacted, true),
        });
        this.shellPatchSignatures.set(`runtime:${runtime.runtimeId}`, stable);
        this.shellRuntimeSignatures.set(`runtime:${runtime.runtimeId}`, {
          stable,
          full: JSON.stringify({ kind: 'upsert', runtime: compacted }),
        });
      }
      // Startup callbacks are suppressed while the workspace and session
      // state is being assembled. The subscription's initial snapshot is the
      // authority; retain one concrete event for the historical cursor.
      try {
        const projection = this.application.shellProjection();
        this.seedApplicationDomainSignatures(projection);
        this.shellPatchSignatures.delete('workspace');
        this.publishShellPatch(
          'workspace',
          {
            workspaces: projection.workspaces,
            shellProjection: projection.shellProjection,
          },
          undefined,
          'workspace',
        );
      } catch (error) {
        // Keep startup available so the shell endpoint can report an explicit
        // hard-capacity failure for an oversized authoritative session index.
        if (
          !(
            error instanceof Error &&
            (error.message ===
              'The authoritative session index exceeds shell capacity.' ||
              error.message ===
                'The authoritative shell snapshot exceeds its frame limit.')
          )
        )
          throw error;
      }
    } catch (error) {
      await this.cleanupFailedStart();
      this.lifecycle = 'stopped';
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.lifecycle === 'stopped') return;
    if (this.lifecycle === 'stopping') {
      await this.stopPromise;
      return;
    }
    if (this.lifecycle === 'starting') {
      try {
        await this.startPromise;
      } catch {
        return;
      }
      if ((this.lifecycle as string) !== 'started') return;
    }
    this.lifecycle = 'stopping';
    const shutdown = this.stopInternal();
    this.stopPromise = shutdown;
    try {
      await shutdown;
    } finally {
      if (this.stopPromise === shutdown) this.stopPromise = undefined;
      this.lifecycle = 'stopped';
    }
  }

  private async listenHttp(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.http.off('error', onError);
        reject(error);
      };
      this.http.once('error', onError);
      this.http.listen({ port: this.port, host: this.host }, () => {
        this.http.off('error', onError);
        resolve();
      });
    });
  }

  private closeAuxiliaryStates(): void {
    for (const state of this.auxiliaryFeeds.values()) {
      for (const waiter of state.gateWaiters)
        waiter.reject(new Error('Auxiliary feed stopped.'));
      state.gateWaiters = [];
    }
    this.auxiliaryFeeds.clear();
  }

  private async stopInternal(): Promise<void> {
    if (this.feedSweepTimer) clearInterval(this.feedSweepTimer);
    this.feedSweepTimer = undefined;
    await this.application.orchestrationService?.stop();
    await (
      this.runtimeProvider as DashboardDependencies['runtimeProvider'] & {
        close?: () => Promise<void>;
      }
    ).close?.();
    this.closeAuxiliaryStates();
    this.sessions.close();
    this.shellFeed.close();
    this.sessionFeeds.close();
    this.registry.close();
    // Destroy raw bridge clients before waiting for the HTTP server to close.
    this.bridge.destroyClients();
    await this.app.close();
    await this.bridge.close(this.socketPath);
    await this.application.uploads.close();
    this.push.close?.();
    this.metadata.close();
  }

  private async cleanupFailedStart(): Promise<void> {
    if (this.feedSweepTimer) clearInterval(this.feedSweepTimer);
    this.feedSweepTimer = undefined;
    await this.application.orchestrationService?.stop();
    await (
      this.runtimeProvider as DashboardDependencies['runtimeProvider'] & {
        close?: () => Promise<void>;
      }
    ).close?.();
    this.closeAuxiliaryStates();
    this.sessions.close();
    this.registry.close();
    this.bridge.destroyClients();
    if (this.http.listening)
      await new Promise<void>((resolve) => this.http.close(() => resolve()));
    await this.bridge.close(this.socketPath);
    await this.application.uploads.close().catch(() => undefined);
  }

  snapshot(cursor = this.shellFeed.sequence): BrowserSnapshot {
    return this.application.snapshot(this.serverId, this.revision, cursor);
  }

  async refreshWorkspaces(): Promise<WorkspaceTarget[]> {
    const workspaces = await this.application.refreshWorkspaces();
    this.workspaces = workspaces;
    if (this.lifecycle === 'started') {
      const projection = this.application.shellProjection();
      this.publishShellPatch(
        'workspace',
        {
          workspaces: projection.workspaces,
          shellProjection: projection.shellProjection,
        },
        undefined,
        'workspace',
      );
    }
    return workspaces;
  }

  private async activeDelegateTranscriptResult(
    id: string,
  ): Promise<ActiveDelegateTranscriptBaseline> {
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(id))
      throw new Error('Invalid session id.');
    const runtime = this.registry
      .snapshots()
      .find((item) => item.session.id === id && item.online !== false);
    return activeDelegateTranscriptBaseline(
      this.serverId,
      this.shellFeed.sequence,
      id,
      runtime,
      runtime
        ? this.registry.transportProvenance(runtime.runtimeId)
        : undefined,
    );
  }

  private async delegateHistoryResult(
    id: string,
  ): Promise<DelegateHistoryResponse> {
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(id))
      throw new Error('Invalid session id.');
    const runtime = this.registry
      .snapshots()
      .find((item) => item.session.id === id && item.online !== false);
    const runtimeLeafId = (
      value: RuntimeSnapshot | undefined,
    ): string | undefined => {
      const leafId = value
        ? (value.session as { leafId?: unknown }).leafId
        : undefined;
      return typeof leafId === 'string' && leafId.length > 0
        ? leafId
        : undefined;
    };
    const working =
      runtime?.liveState === 'working' || runtime?.liveState === 'compacting';
    const leafId = runtime && !working ? runtimeLeafId(runtime) : undefined;
    const result = await this.sessions.readSelectedBranchEntries(
      id,
      leafId,
      isDelegateHistoryEntry,
      {
        resolveLatestLeaf: leafId === undefined,
        projectEntry: (entry) =>
          projectDelegateHistoryEntry(entry, { sessionId: id }),
      },
    );
    return delegateHistoryFromBranch(id, result.entries, result.leafId, {
      truncated: result.entriesTruncated,
    });
  }

  private async delegateHistoryRunResult(
    id: string,
    runId: string,
    query: DelegateHistoryRunQuery,
  ): Promise<DelegateHistoryRunDetailResponse> {
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(id))
      throw new Error('Invalid session id.');
    if (!validDelegateIdentifier(runId))
      throw new Error('Invalid delegate run ID.');
    if (
      query.lineageId !== undefined &&
      !validDelegateIdentifier(query.lineageId)
    )
      throw new Error('Invalid delegate lineage ID.');
    if (query.leafId !== undefined && !validDelegateIdentifier(query.leafId))
      throw new Error('Invalid session leaf ID.');
    const runtime = this.registry
      .snapshots()
      .find((item) => item.session.id === id && item.online !== false);
    const runtimeLeafId = (
      value: RuntimeSnapshot | undefined,
    ): string | undefined => {
      const leafId = value
        ? (value.session as { leafId?: unknown }).leafId
        : undefined;
      return typeof leafId === 'string' && leafId.length > 0
        ? leafId
        : undefined;
    };
    const working =
      runtime?.liveState === 'working' || runtime?.liveState === 'compacting';
    const leafId =
      query.leafId ??
      (runtime && !working ? runtimeLeafId(runtime) : undefined);
    const result = await this.sessions.readSelectedBranchEntries(
      id,
      leafId,
      isDelegateHistoryEntry,
      {
        resolveLatestLeaf: leafId === undefined,
        projectEntry: (entry) =>
          projectDelegateHistoryEntry(entry, {
            sessionId: id,
            detailRunId: runId,
          }),
      },
    );
    return delegateHistoryRunDetailFromBranch(
      id,
      result.entries,
      runId,
      query.lineageId,
      result.leafId,
    );
  }

  private savePushSubscription(body: unknown): void {
    if (
      !body ||
      typeof body !== 'object' ||
      typeof (body as Record<string, unknown>).endpoint !== 'string' ||
      !/^https:\/\//.test((body as Record<string, unknown>).endpoint as string)
    )
      throw new Error('Invalid push subscription.');
    const now = Date.now();
    this.metadata.savePushSubscription({
      endpoint: (body as Record<string, unknown>).endpoint as string,
      subscription: body,
      createdAt: now,
      updatedAt: now,
    });
  }

  private auxiliaryState(sessionId: string): AuxiliaryFeedState {
    const existing = this.auxiliaryFeeds.get(sessionId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (this.auxiliaryFeeds.size >= MAX_AUXILIARY_FEED_STATES) {
      let candidate: [string, AuxiliaryFeedState] | undefined;
      for (const entry of this.auxiliaryFeeds) {
        const [id, state] = entry;
        const feed = this.sessionFeeds.peek(id);
        if (
          state.gateBusy ||
          state.workerRunning ||
          (feed?.active ?? false) ||
          (feed?.metrics().subscribers ?? 0) !== 0 ||
          (candidate && state.lastUsedAt >= candidate[1].lastUsedAt)
        )
          continue;
        candidate = entry;
      }
      if (candidate) this.auxiliaryFeeds.delete(candidate[0]);
    }
    if (this.auxiliaryFeeds.size >= MAX_AUXILIARY_FEED_STATES)
      throw new Error(
        'Auxiliary session feed capacity is reserved for active feeds.',
      );
    const state: AuxiliaryFeedState = {
      pendingSteeringMarkers: [],
      dirty: false,
      workerRunning: false,
      gateBusy: false,
      gateWaiters: [],
      lastUsedAt: Date.now(),
    };
    this.auxiliaryFeeds.set(sessionId, state);
    return state;
  }

  private releaseAuxiliaryGate(state: AuxiliaryFeedState): void {
    const waiter = state.gateWaiters.shift();
    if (!waiter) {
      state.gateBusy = false;
      return;
    }
    // Keep the mutex occupied while handing it to the next bounded waiter;
    // this is an explicit mutex, not an ever-growing promise chain.
    state.gateBusy = true;
    waiter.resolve();
  }

  private async withAuxiliaryGate<T>(
    sessionId: string,
    callback: (state: AuxiliaryFeedState) => Promise<T>,
  ): Promise<T> {
    const state = this.auxiliaryState(sessionId);
    if (state.gateBusy) {
      if (state.gateWaiters.length >= MAX_AUXILIARY_GATE_WAITERS)
        throw new Error('Auxiliary session snapshot gate is busy.');
      await new Promise<void>((resolve, reject) =>
        state.gateWaiters.push({ resolve, reject }),
      );
    } else state.gateBusy = true;
    state.lastUsedAt = Date.now();
    try {
      return await callback(state);
    } finally {
      state.lastUsedAt = Date.now();
      this.releaseAuxiliaryGate(state);
    }
  }

  private async buildSessionSnapshot(
    sessionId: string,
    before: string | undefined,
    sequence: number,
  ): Promise<import('@pi-dashboard/protocol').AuthoritativeSessionSnapshot> {
    if (!this.sessions.isAuxiliary(sessionId) || before !== undefined)
      return this.application.sessionSnapshot(
        this.serverId,
        sessionId,
        before,
        sequence,
      );
    const snapshot = await this.withAuxiliaryGate(sessionId, async (state) => {
      const internal = await this.application.sessionSnapshot(
        this.serverId,
        sessionId,
        undefined,
        sequence,
        true,
      );
      state.cursor = internal.sourceCursor;
      state.pendingSteeringMarkers = [];
      // A watcher that fired while the source cut was being read must remain
      // dirty. The worker will range-read from this exact installed cut.
      state.lastUsedAt = Date.now();
      const { sourceCursor: _sourceCursor, ...publicSnapshot } = internal;
      return publicSnapshot;
    });
    const state = this.auxiliaryFeeds.get(sessionId);
    if (state?.dirty) this.scheduleAuxiliaryWorker(sessionId);
    return snapshot;
  }

  private resetReason(
    error: unknown,
  ): import('@pi-dashboard/protocol').SessionTranscriptResetReason {
    if (error instanceof AuxiliaryAppendError) {
      if (error.reason === 'entry-too-large') return 'entry-too-large';
      if (error.reason === 'source-truncated') return 'source-truncated';
      return 'source-rewrite';
    }
    if (
      error instanceof Error &&
      error.message.includes('cannot be represented')
    )
      return 'entry-too-large';
    return 'source-rewrite';
  }

  private publishAuxiliaryReset(
    sessionId: string,
    reason: import('@pi-dashboard/protocol').SessionTranscriptResetReason,
  ): void {
    const feed = this.sessionFeeds.peek(sessionId);
    if (!feed) return;
    try {
      feed.publishEvent({
        type: 'session.transcript.reset',
        sessionId,
        reason,
      });
    } catch {
      // A reset itself is intentionally tiny; a closed/evicted feed is already
      // a retryable authoritative-snapshot recovery path.
    }
  }

  private invalidateIdleAuxiliaryFeed(
    sessionId: string,
    feed = this.sessionFeeds.peek(sessionId),
  ): void {
    // This synchronous check-and-invalidate is the fail-closed boundary: a
    // subscriber cannot appear between the zero-subscriber check and feed
    // removal on the event loop. Active subscribers are never disturbed.
    if (!feed) {
      this.auxiliaryFeeds.delete(sessionId);
      return;
    }
    if (feed.metrics().subscribers !== 0) return;
    if (this.sessionFeeds.peek(sessionId) === feed)
      this.sessionFeeds.invalidate(sessionId);
    if (this.auxiliaryFeeds.get(sessionId) === undefined) return;
    this.auxiliaryFeeds.delete(sessionId);
  }

  private scheduleAuxiliaryWorker(sessionId: string): void {
    const state = this.auxiliaryFeeds.get(sessionId);
    const feed = this.sessionFeeds.peek(sessionId);
    if (
      !state ||
      !feed ||
      feed.metrics().subscribers === 0 ||
      state.workerRunning
    )
      return;
    state.workerRunning = true;
    void this.runAuxiliaryWorker(sessionId, state).finally(() => {
      state.workerRunning = false;
      if (
        this.auxiliaryFeeds.get(sessionId) === state &&
        state.dirty &&
        this.lifecycle === 'started' &&
        this.sessionFeeds.peek(sessionId)?.metrics().subscribers !== 0
      )
        this.scheduleAuxiliaryWorker(sessionId);
    });
  }

  private async runAuxiliaryWorker(
    sessionId: string,
    state: AuxiliaryFeedState,
  ): Promise<void> {
    while (
      state.dirty &&
      this.lifecycle === 'started' &&
      this.sessions.isAuxiliary(sessionId)
    ) {
      const feed = this.sessionFeeds.peek(sessionId);
      if (!feed || feed.metrics().subscribers === 0) {
        this.invalidateIdleAuxiliaryFeed(sessionId, feed);
        return;
      }
      if (state.cursor === undefined) return;
      state.dirty = false;
      await this.withAuxiliaryGate(sessionId, async (current) => {
        const cursor = current.cursor;
        if (cursor === undefined) return;
        try {
          const range = await this.sessions.readAppendRange(sessionId, cursor);
          const events = persistedEntriesToTranscriptEvents(
            range.records,
            sessionId,
            {
              fallbackEntryOffset: cursor.ordinal,
              steeringMarkers: current.pendingSteeringMarkers,
            },
          );
          for (const event of events) {
            const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
            if (eventBytes >= MAX_FRAME_BYTES)
              throw new AuxiliaryAppendError(
                'entry-too-large',
                'Normalized auxiliary event exceeds the protocol budget.',
              );
            // Source records are not keyed/coalesced. Every persisted event
            // consumes one feed sequence in source order.
            feed.publishEvent(event);
          }
          // Commit only after every record in this range has been published.
          current.cursor = range.nextCursor;
          if (range.records.length > 0) {
            let suffixStart = range.records.length;
            while (
              suffixStart > 0 &&
              isPersistedSteeringMarker(range.records[suffixStart - 1])
            )
              suffixStart -= 1;
            current.pendingSteeringMarkers = range.records.slice(suffixStart);
          }
          if (range.hasMore && range.records.length > 0) current.dirty = true;
        } catch (error) {
          current.cursor = undefined;
          current.dirty = false;
          this.publishAuxiliaryReset(sessionId, this.resetReason(error));
        }
      });
    }
  }

  public handleRegistryChange(change: RegistryChange): void {
    const applicationChange = this.application.onRegistryChange(change);
    if (this.lifecycle !== 'started') return;
    const sessionId = change.snapshot.session.id;
    const runtimeGone =
      change.kind === 'removed' ||
      (change.kind === 'event' &&
        change.event.type === 'runtime.goodbye' &&
        this.registry.get(change.snapshot.runtimeId) === undefined);
    // Feed activity follows online runtime ownership, not registry record
    // retention. Offline records remain available for bounded replay only.
    const sessionActive = this.registry
      .snapshots()
      .some(
        (runtime) =>
          runtime.session.id === sessionId && runtime.online !== false,
      );
    try {
      this.sessionFeeds.setActive(sessionId, sessionActive);
    } catch {
      // Capacity exhaustion is recoverable: the next subscription gets an
      // authoritative snapshot, and registry callbacks must not escape.
    }
    if (applicationChange.type === 'event') {
      const event = projectPublicBridgeEvent(
        applicationChange.event as BridgeEvent,
      );
      const key = sessionEventCoalesceKey(event);
      try {
        this.sessionFeeds.publish(
          sessionId,
          event,
          {
            ...(applicationChange.runtimeId === undefined
              ? {}
              : { runtimeId: applicationChange.runtimeId }),
            ...(applicationChange.runtimeEpoch === undefined
              ? {}
              : { runtimeEpoch: applicationChange.runtimeEpoch }),
            ...(applicationChange.runtimeSeq === undefined
              ? {}
              : { runtimeSeq: applicationChange.runtimeSeq }),
          },
          key,
        );
      } catch {
        // The next reconnect receives an authoritative session snapshot.
      }
      const domain = shellDomainForEvent(event);
      if (domain !== undefined) {
        this.publishShellPatch(
          domain,
          compactShellEventData(event, change.snapshot.runtimeId),
          sessionId,
          `runtime:${sessionId}:${domain}`,
        );
      }
    } else {
      const hello = projectPublicBridgeEvent({
        type: 'runtime.hello',
        protocolVersion: PROTOCOL_VERSION,
        snapshot: change.snapshot,
      } as BridgeEvent);
      try {
        this.sessionFeeds.publish(sessionId, hello, {
          runtimeId: change.snapshot.runtimeId,
          ...(change.runtimeEpoch === undefined
            ? {}
            : { runtimeEpoch: change.runtimeEpoch }),
          ...(change.runtimeSeq === undefined
            ? {}
            : { runtimeSeq: change.runtimeSeq }),
        });
      } catch {
        // A reconnect always has the authoritative session snapshot fallback.
      }
    }

    this.publishSessionIndexDelta(this.application.sessionMetadataDelta());
    if (runtimeGone) {
      const runtimeKey = `runtime:${change.snapshot.runtimeId}`;
      this.shellRuntimeSignatures.delete(runtimeKey);
      this.publishShellPatch(
        'runtime',
        { kind: 'remove', runtimeId: change.snapshot.runtimeId },
        sessionId,
        runtimeKey,
      );
    } else
      this.publishRuntimePatch(
        change.snapshot,
        sessionId,
        change.kind === 'event' && !transcriptOnlyShellEvent(change.event),
      );
    // Registry callbacks may also update notifications or orchestration. The
    // concrete signatures suppress host.changed() amplification when they do
    // not alter shell-visible state.
    this.publishApplicationDomains();
  }

  public publishChange(message?: unknown): void {
    if (this.lifecycle !== 'started') return;
    this.changed(message);
  }

  public publishSessionIndexChange(
    sessionId?: string,
    auxiliary = false,
  ): void {
    if (this.lifecycle !== 'started') return;
    // Persist the identity before publishing metadata. A client receiving this
    // delta can therefore immediately use the link projection for controls.
    this.application.orchestrationService?.ensureSessionThreadLinks(
      this.sessions.list(),
    );
    this.publishSessionIndexDelta(this.application.sessionMetadataDelta());
    if (!sessionId || (!auxiliary && !this.sessions.isAuxiliary(sessionId)))
      return;
    const current = this.sessions.get(sessionId);
    if (!current) {
      this.auxiliaryFeeds.delete(sessionId);
      this.sessionFeeds.invalidate(sessionId);
      return;
    }
    // A normal session wins an ID collision; never publish it on a child feed.
    if (!this.sessions.isAuxiliary(sessionId)) return;
    const feed = this.sessionFeeds.peek(sessionId);
    // Watchers before the first subscriber must not turn old child history into
    // a replay. The first authoritative snapshot seeds at the current end.
    if (!feed || feed.metrics().subscribers === 0) {
      this.invalidateIdleAuxiliaryFeed(sessionId, feed);
      return;
    }
    let state: AuxiliaryFeedState;
    try {
      state = this.auxiliaryState(sessionId);
    } catch {
      // Feed capacity is bounded; an eventual authoritative subscription is
      // the only safe recovery when all inactive state is pinned.
      return;
    }
    state.dirty = true;
    state.lastUsedAt = Date.now();
    this.scheduleAuxiliaryWorker(sessionId);
  }

  private publishSessionIndexDelta(
    delta: SessionMetadataDelta | undefined,
  ): void {
    if (!delta) return;
    const tooLarge =
      delta.upsert.length > MAX_SESSION_INDEX_DELTA_ITEMS ||
      delta.remove.length > MAX_SESSION_INDEX_DELTA_ITEMS ||
      Buffer.byteLength(JSON.stringify(delta), 'utf8') >=
        MAX_SESSION_INDEX_DELTA_BYTES;
    const sessions = this.application.sessionMetadata();
    if (sessions.length > MAX_SHELL_INDEX_ITEMS)
      throw new Error(
        'The authoritative session index exceeds shell capacity.',
      );
    const data: ShellFeedData = (
      tooLarge
        ? { kind: 'replace', sessions }
        : {
            kind: 'delta',
            upsert: delta.upsert,
            remove: delta.remove,
          }
    ) as ShellFeedData;
    if (
      Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_SHELL_SNAPSHOT_BYTES
    )
      throw new Error(
        'The authoritative session index exceeds its frame limit.',
      );
    this.publishShellPatch('session-index', data, undefined, 'session-index');
  }

  private publishRuntimePatch(
    runtime: RuntimeSnapshot,
    sessionId: string,
    includeHeartbeat: boolean,
  ): void {
    const compacted = shellRuntime(runtime) as ShellRuntimeSnapshot;
    const key = `runtime:${runtime.runtimeId}`;
    const stable = JSON.stringify({
      kind: 'upsert',
      runtime: shellRuntimeComparison(compacted, true),
    });
    const full = JSON.stringify({ kind: 'upsert', runtime: compacted });
    const prior = this.shellRuntimeSignatures.get(key);
    if (
      prior?.[includeHeartbeat ? 'full' : 'stable'] ===
      (includeHeartbeat ? full : stable)
    )
      return;
    this.publishShellPatch(
      'runtime',
      { kind: 'upsert', runtime: compacted },
      sessionId,
      key,
      includeHeartbeat ? full : stable,
    );
    this.shellRuntimeSignatures.set(key, { stable, full });
  }

  private seedApplicationDomainSignatures(
    projection = this.application.shellProjection(),
  ): void {
    this.shellPatchSignatures.set(
      'workspace',
      JSON.stringify({
        workspaces: projection.workspaces,
        shellProjection: projection.shellProjection,
      }),
    );
    this.shellPatchSignatures.set(
      'orchestration',
      JSON.stringify({
        projects: projection.projects,
        checkouts: projection.checkouts,
        threads: projection.threads,
        runs: projection.runs,
        shellProjection: projection.shellProjection,
      }),
    );
    this.shellPatchSignatures.set(
      'usage',
      JSON.stringify({
        usage: projection.usage,
        shellProjection: projection.shellProjection,
      }),
    );
    this.shellPatchSignatures.set(
      'notification',
      JSON.stringify({
        unread: projection.unread,
        shellProjection: projection.shellProjection,
      }),
    );
  }

  private publishApplicationDomains(): void {
    const projection = this.application.shellProjection();
    this.publishShellPatch(
      'workspace',
      {
        workspaces: projection.workspaces,
        shellProjection: projection.shellProjection,
      },
      undefined,
      'workspace',
    );
    this.publishShellPatch(
      'orchestration',
      {
        projects: projection.projects,
        checkouts: projection.checkouts,
        threads: projection.threads,
        runs: projection.runs,
        shellProjection: projection.shellProjection,
      },
      undefined,
      'orchestration',
    );
    this.publishShellPatch(
      'usage',
      {
        usage: projection.usage,
        shellProjection: projection.shellProjection,
      },
      undefined,
      'usage',
    );
    this.publishShellPatch(
      'notification',
      {
        unread: projection.unread,
        shellProjection: projection.shellProjection,
      },
      undefined,
      'notification',
    );
  }

  private publishShellPatch(
    domain: ShellFeedDomain,
    data: ShellFeedData,
    sessionId: string | undefined,
    key: string,
    signatureValue: unknown = data,
  ): void {
    const signature = JSON.stringify(signatureValue);
    if (this.shellPatchSignatures.get(key) === signature) return;
    this.shellPatchSignatures.set(key, signature);
    this.revision += 1;
    try {
      this.shellFeed.publishSemantic(
        domain,
        this.revision,
        data,
        sessionId,
        key,
      );
    } catch {
      // Overflow and oversized records are recovered by a cursor-free shell
      // subscription snapshot; no finite read is scheduled here.
    }
  }

  private changed(message?: unknown): void {
    const record =
      message && typeof message === 'object' && !Array.isArray(message)
        ? (message as Record<string, unknown>)
        : undefined;
    if (record?.type === 'sessions')
      this.publishSessionIndexDelta(this.application.sessionMetadataDelta());
    else if (record?.domain === 'usage') this.publishApplicationDomains();
    else if (record?.domain === 'workspace') this.publishApplicationDomains();
    else if (record?.domain === 'orchestration')
      this.publishApplicationDomains();
    else {
      // applicationChanges intentionally carries no source context. Compare
      // every concrete catalogue instead of emitting an opaque event.
      this.publishApplicationDomains();
    }
  }
}

export async function createDashboardServer(
  options: DashboardServerOptions = {},
): Promise<DashboardServer> {
  const { createDaemon } = await import('./create-daemon.js');
  return createDaemon(options);
}

export type { DashboardServerOptions } from './composition.js';
