import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type http from 'node:http';
import {
  delegateHistoryFromBranch,
  delegateHistoryRunDetailFromBranch,
  isDelegateHistoryEntry,
  projectDelegateHistoryEntry,
} from '@pi-dashboard/domain';
import {
  type ActiveDelegateTranscriptBaseline,
  type BridgeEvent,
  type BrowserSnapshot,
  type DelegateHistoryResponse,
  type DelegateHistoryRunDetailResponse,
  type DelegateHistoryRunQuery,
  type DelegateLiveRun,
  MAX_ID,
  MAX_SESSION_INDEX_DELTA_ITEMS,
  PROTOCOL_VERSION,
  type RuntimeSnapshot,
  tryParseActiveDelegateTranscriptBaseline,
  tryParseDelegateTranscriptEntry,
  validateBridgeCommand,
  validateSessionRenameRequest,
  type WorkspaceTarget,
} from '@pi-dashboard/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import { projectPublicBridgeEvent } from './application/dashboard-application.js';
import type {
  DashboardDependencies,
  DashboardServerOptions,
} from './composition.js';
import { BridgeListener } from './http/bridge-listener.js';
import {
  compactShellEventData,
  type SessionFeedRegistry,
  type ShellFeed,
  shellDomainForEvent,
} from './live-feeds.js';
import { createPushSender } from './push.js';
import { type DashboardRouteContext, dashboardRoutes } from './routes.js';
import type { RegistryChange } from './runtime-registry.js';

/** Keep session deltas comfortably below the authoritative frame limit. */
const MAX_SESSION_INDEX_DELTA_BYTES = 1_500_000;

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
  publishSessionIndexChange(): void;
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
        this.application.sessionSnapshot(
          this.serverId,
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
        this.application.sessionSnapshot(
          this.serverId,
          id,
          undefined,
          sequence,
        ),
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
        const result = await this.application.runtime.restart(
          runtimeId,
          commandId,
        );
        this.changed();
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
      await this.refreshWorkspaces();
      await this.sessions.start(this.workspaces);
      // Seed metadata before the file watcher is allowed to publish deltas.
      this.application.initializeSessionMetadataBaseline();
      await this.application.orchestrationService?.start();
      if (!this.pushConfigured)
        this.push = await createPushSender(this.metadata);
      this.application.setPush(this.push);
      this.feedSweepTimer = setInterval(
        () =>
          this.sessionFeeds.sweep(
            Date.now(),
            this.configuration.feedInactivityMs,
          ),
        Math.max(
          30_000,
          Math.min(this.configuration.feedInactivityMs, 5 * 60_000),
        ),
      );
      this.feedSweepTimer.unref();
      this.lifecycle = 'started';
      // Startup callbacks are suppressed while the workspace and session
      // state is being assembled. Publish one authoritative initial snapshot.
      this.changed();
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

  private async stopInternal(): Promise<void> {
    if (this.feedSweepTimer) clearInterval(this.feedSweepTimer);
    this.feedSweepTimer = undefined;
    await this.application.orchestrationService?.stop();
    await (
      this.runtimeProvider as DashboardDependencies['runtimeProvider'] & {
        close?: () => Promise<void>;
      }
    ).close?.();
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

  public handleRegistryChange(change: RegistryChange): void {
    const applicationChange = this.application.onRegistryChange(change);
    if (this.lifecycle !== 'started') return;
    this.revision += 1;
    const sessionId = change.snapshot.session.id;
    const runtimeGone =
      change.kind === 'offline' ||
      (change.kind === 'event' && change.event.type === 'runtime.goodbye');
    this.sessionFeeds.setActive(sessionId, !runtimeGone);
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
        try {
          this.shellFeed.publishSemantic(
            domain,
            this.revision,
            compactShellEventData(event),
            sessionId,
            `runtime:${sessionId}:${domain}`,
          );
        } catch {
          // The authoritative shell snapshot is the recovery path.
        }
      }
      return;
    }
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
    try {
      this.shellFeed.publishSemantic(
        'runtime',
        this.revision,
        {
          runtimeId: change.snapshot.runtimeId,
          liveState: change.snapshot.liveState,
        },
        sessionId,
        `runtime:${sessionId}:lifecycle`,
      );
    } catch {
      // The authoritative shell snapshot is the recovery path.
    }
  }

  public publishChange(message?: unknown): void {
    if (this.lifecycle !== 'started') return;
    this.changed(message);
  }

  public publishSessionIndexChange(): void {
    if (this.lifecycle !== 'started') return;
    const delta = this.application.sessionMetadataDelta();
    if (!delta) return;
    const tooLarge =
      delta.upsert.length > MAX_SESSION_INDEX_DELTA_ITEMS ||
      delta.remove.length > MAX_SESSION_INDEX_DELTA_ITEMS ||
      Buffer.byteLength(JSON.stringify(delta), 'utf8') >=
        MAX_SESSION_INDEX_DELTA_BYTES;
    this.revision += 1;
    try {
      this.shellFeed.publishSemantic(
        'session-index',
        this.revision,
        tooLarge ? { refresh: true } : delta,
        undefined,
        'session-index',
      );
    } catch {
      // The next shell subscription starts from an authoritative snapshot.
    }
  }

  private changed(message?: unknown): void {
    this.revision += 1;
    const record =
      message && typeof message === 'object' && !Array.isArray(message)
        ? (message as Record<string, unknown>)
        : undefined;
    const domain =
      record?.type === 'sessions'
        ? 'session-index'
        : record?.domain === 'usage'
          ? 'usage'
          : record?.domain === 'workspace'
            ? 'workspace'
            : record?.domain === 'orchestration'
              ? 'orchestration'
              : 'invalidation';
    const data =
      domain === 'session-index' &&
      record &&
      Array.isArray(record.upsert) &&
      Array.isArray(record.remove)
        ? {
            upsert: record.upsert.slice(0, MAX_SESSION_INDEX_DELTA_ITEMS),
            remove: record.remove.slice(0, MAX_SESSION_INDEX_DELTA_ITEMS),
          }
        : { refresh: true };
    try {
      this.shellFeed.publishSemantic(
        domain,
        this.revision,
        data,
        undefined,
        `application:${domain}`,
      );
    } catch {
      // A bounded feed retries via its authoritative shell snapshot.
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
