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
  sessionDirectory,
} from './composition.js';
import { DashboardEventStream } from './event-stream.js';
import { type DashboardServer, DashboardServerImpl } from './http.js';
import { MetadataStore } from './metadata.js';
import type { PushSender } from './push.js';
import { RuntimeManager } from './runtime-manager.js';
import { type RegistryChange, RuntimeRegistry } from './runtime-registry.js';
import { CliSeshAdapter } from './sesh.js';
import { SessionIndex } from './session-index.js';
import { TmuxAdapter, TmuxRuntimeProvider } from './tmux.js';
import { CodexUsageProvider } from './usage.js';

const SSE_HEARTBEAT_MS = 15_000;
const SSE_BUFFER_BYTES = 1024 * 1024;

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
    origins,
    sseHeartbeatMs: options.sseHeartbeatMs ?? SSE_HEARTBEAT_MS,
    sseBufferBytes: options.sseBufferBytes ?? SSE_BUFFER_BYTES,
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
} {
  const registryChanges = new ChangeRelay<RegistryChange>();
  const applicationChanges = new ChangeRelay<void>();
  const metadata =
    options.metadata ??
    new MetadataStore(path.join(config.stateDir, 'dashboard.sqlite'));
  const sessions =
    options.sessions ??
    new SessionIndex(sessionDirectory(options), metadata, () =>
      applicationChanges.publish(undefined),
    );
  const sesh = options.sesh ?? new CliSeshAdapter();
  const tmux = options.tmux ?? new TmuxAdapter();
  const runtimeProvider =
    options.runtimeProvider ?? new TmuxRuntimeProvider(tmux);
  const usage = options.usage ?? new CodexUsageProvider();
  const eventStream = new DashboardEventStream(options.eventBufferSize ?? 256);
  const pushConfigured = Boolean(options.push);
  const push = options.push ?? noopPush();

  let manager!: RuntimeManager;
  const registry =
    options.registry ??
    new RuntimeRegistry({
      allowExternalWithoutToken: true,
      expectedToken: (runtimeId, launchToken, identityToken) =>
        manager.expectedToken(runtimeId, launchToken, identityToken),
      onChange: (change) => registryChanges.publish(change),
    });
  manager = new RuntimeManager(
    registry,
    runtimeProvider,
    sessions,
    metadata,
    config.socketPath,
  );
  const orchestrationService = new OrchestrationService({
    repository: metadata.orchestration,
    manager,
    registry,
    workspaces: () => manager.activeWorkspaces(),
    readSession: (id) => sessions.readEntries(id),
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
    eventStream,
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
      tmux,
      runtimeProvider,
      usage,
      push,
      pushConfigured,
      eventStream,
      registry,
      manager,
      orchestrationService,
      application,
    },
    registryChanges,
    applicationChanges,
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
  return server;
}

export type {
  DashboardConfiguration,
  DashboardDependencies,
  DashboardServerOptions,
} from './composition.js';
