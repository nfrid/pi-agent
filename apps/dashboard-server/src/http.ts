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
  type BridgeCommand,
  type BridgeEvent,
  type BrowserSnapshot,
  type DelegateHistoryResponse,
  type DelegateHistoryRunDetailResponse,
  type DelegateHistoryRunQuery,
  MAX_ID,
  MAX_SESSION_INDEX_DELTA_ITEMS,
  MAX_SHELL_INDEX_ITEMS,
  MAX_SHELL_SNAPSHOT_BYTES,
  PROTOCOL_VERSION,
  type RuntimeSnapshot,
  type ShellFeedData,
  type ShellFeedDomain,
  type ShellRuntimeSnapshot,
  validateBridgeCommand,
  validateSessionRenameRequest,
} from '@pi-dashboard/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  projectPublicBridgeEvent,
  type SessionMetadataDelta,
  shellRuntime,
} from './application/dashboard-application.js';
import type { DashboardImage } from './application/upload-service.js';
import {
  composerCommandCatalogue,
  composerFileSuggestions,
} from './composer-autocomplete.js';
import type {
  DashboardDependencies,
  DashboardServerOptions,
} from './composition.js';
import { readGitContext } from './git-context.js';
import { BridgeListener } from './http/bridge-listener.js';
import type { SessionFeedRegistry, ShellFeed } from './live-feeds.js';
import {
  deleteProjectIconOverride,
  readProjectIcon,
  readProjectIconOverride,
  writeProjectIconOverride,
} from './project-icon.js';
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
  /** Session-free source state used to skip unchanged catalogue projections. */
  private applicationDomainSignature: string | undefined;
  /** Runtime signatures retain both heartbeat recency and stable shell state. */
  private readonly shellRuntimeSignatures = new Map<
    string,
    { stable: string; full: string }
  >();

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

  private async withUploadedImages<T>(
    imageBuffers: readonly Buffer[],
    operation: (
      images: readonly DashboardImage[],
      release: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    const images =
      imageBuffers.length > 0
        ? await this.application.uploads.save(imageBuffers)
        : [];
    const release = () =>
      this.application.uploads.cleanup(images.map((image) => image.path));
    try {
      return await operation(images, release);
    } catch (error) {
      await release();
      throw error;
    }
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
      composerCommands: composerCommandCatalogue,
      composerFileSuggestions,
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
      sessionImage: (sessionId, entryId, imageIndex, messageTimestamp) =>
        this.sessions.readImage(
          sessionId,
          entryId,
          imageIndex,
          messageTimestamp,
        ),
      projectIcon: async (projectId) => {
        const project = this.metadata.orchestration.getProject(projectId);
        if (!project) return undefined;
        return (
          (await readProjectIconOverride(this.stateDir, projectId)) ??
          readProjectIcon(project.rootPath)
        );
      },
      setProjectIcon: async (projectId, data) => {
        if (!this.metadata.orchestration.getProject(projectId))
          throw new Error('Project not found.');
        await writeProjectIconOverride(this.stateDir, projectId, data);
      },
      resetProjectIcon: async (projectId) => {
        if (!this.metadata.orchestration.getProject(projectId))
          throw new Error('Project not found.');
        await deleteProjectIconOverride(this.stateDir, projectId);
      },
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
      usage: () => this.application.usage.get(),
      settings: () => this.metadata.getDashboardSettings(),
      updateModelDisplayPreference: (modelKey, preference) =>
        this.metadata.updateModelDisplayPreference(modelKey, preference),
      resetModelDisplayPreference: (modelKey) =>
        this.metadata.resetModelDisplayPreference(modelKey),
      importModelDisplayPreferences: (preferences) =>
        this.metadata.importModelDisplayPreferences(preferences),
      usageHistory: (range, before) =>
        this.application.usage.history(range, before),
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
      renameProject: (projectId, command) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.renameProject(
          projectId,
          command as Parameters<typeof service.renameProject>[1],
        );
      },
      createThread: async (projectId, command, imageBuffers) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return this.withUploadedImages(imageBuffers, (images, release) =>
          service.createThread(projectId, {
            ...(command as Parameters<typeof service.createThread>[1]),
            ...(images.length > 0 ? { images, releaseImages: release } : {}),
          }),
        );
      },
      gitContext: async (projectId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        const project = service.requireProject(projectId);
        return readGitContext(project.rootPath);
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
      retryRun: async (threadId, command, imageBuffers) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return this.withUploadedImages(imageBuffers, (images, release) =>
          service.retryRun(threadId, {
            ...(command as Parameters<typeof service.retryRun>[1]),
            ...(images.length > 0 ? { images, releaseImages: release } : {}),
          }),
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
      regenerateThreadTitle: (threadId, commandId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.regenerateThreadTitle(threadId, commandId);
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
      settleThread: (threadId, commandId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.settleThread(threadId, commandId);
      },
      unsettleThread: (threadId, commandId) => {
        const service = this.application.orchestrationService;
        if (!service) throw new Error('Orchestration is unavailable.');
        return service.unsettleThread(threadId, commandId);
      },
      listThreads: (projectId) =>
        this.application.orchestration.listThreads(projectId),
      sessionThreadLinks: () => {
        const indexedSessionIds = new Set(
          this.sessions.list().map((session) => session.id),
        );
        return this.application.orchestration
          .sessionThreadLinks()
          .filter((link) => indexedSessionIds.has(link.sessionId));
      },
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
      // Keep the HTTP boundary closed until session indexing and watcher
      // installation are complete.
      await this.sessions.start();
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
      // Startup callbacks are suppressed while session state is assembled.
      // The subscription's initial snapshot is authoritative.
      try {
        const projection = this.application.shellProjection();
        this.seedApplicationDomainSignatures(projection);
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
      this.application.usage.start();
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
    await this.application.usage.stop();
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
    await this.application.usage.stop();
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

  private buildSessionSnapshot(
    sessionId: string,
    before: string | undefined,
    sequence: number,
  ): Promise<import('@pi-dashboard/protocol').AuthoritativeSessionSnapshot> {
    return this.application.sessionSnapshot(
      this.serverId,
      sessionId,
      before,
      sequence,
    );
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
    if (change.kind === 'registered' && change.reconnected) {
      // The bridge may have missed terminal transcript events while offline.
      // Replace the feed so connected browsers resume through one
      // authoritative snapshot instead of remaining live on an incomplete
      // sequence that cannot describe those persisted entries.
      this.sessionFeeds.invalidate(sessionId);
    }
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

    this.publishSessionIndexDelta(
      this.application.sessionMetadataDeltaForSession(sessionId),
    );
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
    // Orchestration publishes through its own change relay. Only rebuild the
    // remaining catalogues when this callback can create a notification.
    if (
      change.kind === 'offline' ||
      (change.kind === 'event' &&
        (change.event.type === 'runtime.goodbye' ||
          (change.event.type === 'agent.settled' &&
            process.env.PI_DASHBOARD_NOTIFY_SETTLED === '1')))
    )
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
    // Persist the identity before publishing metadata. Scoped watcher events
    // adopt only their exact session; unscoped refreshes retain the bounded
    // full-index fallback used at startup.
    const indexedSession =
      sessionId && !auxiliary ? this.sessions.get(sessionId) : undefined;
    const sessionsToLink = indexedSession
      ? [indexedSession]
      : sessionId || auxiliary
        ? []
        : this.sessions.list();
    if (sessionsToLink.length > 0)
      this.application.orchestrationService?.ensureSessionThreadLinks(
        sessionsToLink,
      );
    this.publishSessionIndexDelta(this.application.sessionMetadataDelta());
    if (!sessionId || (!auxiliary && !this.sessions.isAuxiliary(sessionId)))
      return;
    // Auxiliary files remain discoverable and indexed, but their JSONL writes
    // never become live feed events. Active child runtimes own that transport.
    if (!this.sessions.get(sessionId)) this.sessionFeeds.invalidate(sessionId);
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
    const sessions = tooLarge ? this.application.sessionMetadata() : undefined;
    if (sessions && sessions.length > MAX_SHELL_INDEX_ITEMS)
      throw new Error(
        'The authoritative session index exceeds shell capacity.',
      );
    const data: ShellFeedData = (
      tooLarge
        ? { kind: 'replace', sessions: sessions ?? [] }
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
    this.applicationDomainSignature =
      this.application.applicationDomainSignature();
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
    const sourceSignature = this.application.applicationDomainSignature();
    if (sourceSignature === this.applicationDomainSignature) return;
    const projection = this.application.shellProjection();
    this.applicationDomainSignature = sourceSignature;
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
