import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DashboardApplication } from './application/dashboard-application.js';
import { OrchestrationService } from './application/orchestration-service.js';
import {
  ChangeRelay,
  type DashboardConfiguration,
  type DashboardDependencies,
  type DashboardServerOptions,
  delegateSessionDirectory,
  sessionDirectory,
} from './composition.js';
import { HeadlessRuntimeProvider } from './headless-runtime-provider.js';
import { type DashboardServer, DashboardServerImpl } from './http.js';
import { SessionFeedRegistry, ShellFeed } from './live-feeds.js';
import { MetadataStore } from './metadata.js';
import { ProjectResolver } from './project-resolver.js';
import type { PushSender } from './push.js';
import { RuntimeManager } from './runtime-manager.js';
import { type RegistryChange, RuntimeRegistry } from './runtime-registry.js';
import { CliSeshAdapter } from './sesh.js';
import { SessionIndex } from './session-index.js';
import { CodexUsageProvider } from './usage.js';

const FEED_INACTIVITY_MS = 5 * 60_000;

function loadOrCreateToken(stateDir: string): string {
  const file = path.join(stateDir, 'browser-token');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32 && existing.length <= 512) return existing;
  } catch {
    /* create below */
  }
  const token = randomBytes(32).toString('base64url');
  try {
    writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(file, 0o600);
    return token;
  } catch {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32 && existing.length <= 512) return existing;
    throw new Error('Could not create a stable dashboard browser token.');
  }
}

function configuration(
  options: DashboardServerOptions,
): DashboardConfiguration {
  const host = options.host ?? process.env.PI_DASHBOARD_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.PI_DASHBOARD_PORT ?? 0);
  const stateDir =
    options.stateDir ??
    process.env.PI_DASHBOARD_STATE_DIR ??
    path.join(process.env.HOME ?? process.cwd(), '.pi', 'agent', 'dashboard');
  const token =
    options.authToken ??
    process.env.PI_DASHBOARD_AUTH_TOKEN ??
    loadOrCreateToken(stateDir);
  const socketPath =
    options.socketPath ??
    (options.stateDir
      ? path.join(stateDir, 'bridge.sock')
      : (process.env.PI_DASHBOARD_SOCKET ??
        path.join(stateDir, 'bridge.sock')));
  const runtimeHostSocketPath =
    options.runtimeHostSocketPath ??
    process.env.PI_DASHBOARD_RUNTIME_HOST_SOCKET ??
    path.join(stateDir, 'runtime-host.sock');
  const origins = [
    ...(options.origins ?? [
      `http://${host}:${port}`,
      `http://localhost:${port}`,
      ...(process.env.PI_DASHBOARD_ORIGINS?.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean) ?? []),
    ]),
  ];
  return {
    host,
    port,
    stateDir,
    token,
    socketPath,
    runtimeHostSocketPath,
    origins,
    feedReplayCount: options.feedReplayCount ?? 256,
    feedReplayBytes: options.feedReplayBytes ?? 4 * 1024 * 1024,
    feedQueueCount: options.feedQueueCount ?? 128,
    feedQueueBytes: options.feedQueueBytes ?? 4 * 1024 * 1024,
    feedInactivityMs: options.feedInactivityMs ?? FEED_INACTIVITY_MS,
  };
}

function noopPush(): PushSender {
  return {
    async notify() {
      /* installed after start */
    },
  };
}

function dependencies(
  options: DashboardServerOptions,
  config: DashboardConfiguration,
): {
  dependencies: DashboardDependencies;
  registryChanges: ChangeRelay<RegistryChange>;
  applicationChanges: ChangeRelay<void>;
  sessionIndexChanges: ChangeRelay<{
    sessionId?: string;
    auxiliary?: boolean;
  }>;
} {
  const registryChanges = new ChangeRelay<RegistryChange>();
  const applicationChanges = new ChangeRelay<void>();
  const sessionIndexChanges = new ChangeRelay<{
    sessionId?: string;
    auxiliary?: boolean;
  }>();
  const metadata =
    options.metadata ??
    new MetadataStore(path.join(config.stateDir, 'dashboard.sqlite'));
  const sessions =
    options.sessions ??
    new SessionIndex(
      sessionDirectory(options),
      metadata,
      (sessionId, auxiliary) =>
        sessionIndexChanges.publish({
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(auxiliary === undefined ? {} : { auxiliary }),
        }),
      delegateSessionDirectory(options),
    );
  const sesh = options.sesh ?? new CliSeshAdapter();
  const projectResolver = new ProjectResolver(metadata.orchestration);
  let manager!: RuntimeManager;
  const registry =
    options.registry ??
    new RuntimeRegistry({
      allowExternalWithoutToken: true,
      resolveRuntime: (cwd) => projectResolver.resolve(cwd),
      expectedToken: (runtimeId, launchToken, identityToken) =>
        manager.expectedToken(runtimeId, launchToken, identityToken),
      onChange: (change) => registryChanges.publish(change),
    });
  const runtimeProvider =
    options.runtimeProvider ??
    new HeadlessRuntimeProvider(config.runtimeHostSocketPath);
  const usage = options.usage ?? new CodexUsageProvider();
  const shellFeed = new ShellFeed({
    replayCount: config.feedReplayCount,
    replayBytes: config.feedReplayBytes,
    subscriberQueueCount: config.feedQueueCount,
    subscriberQueueBytes: config.feedQueueBytes,
  });
  const sessionFeeds = new SessionFeedRegistry({
    generation: shellFeed.generation,
    replayCount: config.feedReplayCount,
    replayBytes: config.feedReplayBytes,
    subscriberQueueCount: config.feedQueueCount,
    subscriberQueueBytes: config.feedQueueBytes,
  });
  const pushConfigured = Boolean(options.push);
  const push = options.push ?? noopPush();

  manager = new RuntimeManager(
    registry,
    runtimeProvider,
    sessions,
    metadata,
    config.socketPath,
    metadata.orchestration,
  );
  const orchestrationService = new OrchestrationService({
    repository: metadata.orchestration,
    manager,
    registry,
    workspaces: () => manager.activeWorkspaces(),
    getSession: (id) => sessions.get(id),
    readSession: (id) => sessions.readEntries(id),
    defaultRuntimeProvider: 'extension-bridge',
    onChange: () => applicationChanges.publish(undefined),
  });
  const application = new DashboardApplication({
    registry,
    manager,
    sessions,
    metadata,
    sesh,
    usage,
    push,
    stateDir: config.stateDir,
    orchestration: orchestrationService,
    onChange: () => applicationChanges.publish(undefined),
  });
  return {
    dependencies: {
      configuration: config,
      metadata,
      orchestration: metadata.orchestration,
      sessions,
      sesh,
      runtimeProvider,
      usage,
      push,
      pushConfigured,
      shellFeed,
      sessionFeeds,
      registry,
      manager,
      orchestrationService,
      application,
    },
    registryChanges,
    applicationChanges,
    sessionIndexChanges,
  };
}

/** Manual composition root for the dashboard daemon. */
export async function createDaemon(
  options: DashboardServerOptions = {},
): Promise<DashboardServer> {
  const config = configuration(options);
  const composed = dependencies(options, config);
  const server = new DashboardServerImpl(composed.dependencies);
  composed.registryChanges.connect((change) =>
    server.handleRegistryChange(change),
  );
  composed.applicationChanges.connect(() => server.publishChange());
  composed.sessionIndexChanges.connect((change) =>
    server.publishSessionIndexChange(change.sessionId, change.auxiliary),
  );
  return server;
}

export type {
  DashboardConfiguration,
  DashboardDependencies,
  DashboardServerOptions,
} from './composition.js';
