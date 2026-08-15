import path from 'node:path';
import type { AgentRuntimeProvider } from '@pi-dashboard/protocol';
import type { DashboardApplication } from './application/dashboard-application.js';
import type { OrchestrationService } from './application/orchestration-service.js';
import type { SessionFeedRegistry, ShellFeed } from './live-feeds.js';
import type { MetadataStore } from './metadata.js';
import type { PushSender } from './push.js';
import type { SqliteOrchestrationRepository } from './repositories/sqlite-orchestration-repository.js';
import type { RuntimeManager } from './runtime-manager.js';
import type { RuntimeRegistry } from './runtime-registry.js';
import type { SeshAdapter } from './sesh.js';
import type { SessionIndex } from './session-index.js';
import type { TmuxAdapter } from './tmux.js';
import type { UsageProvider } from './usage.js';

export interface DashboardServerOptions {
  host?: string;
  port?: number;
  socketPath?: string;
  authToken?: string;
  origins?: readonly string[];
  stateDir?: string;
  sessionDir?: string;
  /** Hidden Pi child sessions addressable by ID but omitted from shell listings. */
  delegateSessionDir?: string;
  sesh?: SeshAdapter;
  /** Legacy tmux runner seam retained for callers that customize launch. */
  tmux?: TmuxAdapter;
  runtimeProvider?: AgentRuntimeProvider;
  /** Explicit opt-in for the externally supervised Pi server experiment. */
  experimentalPiServer?: boolean;
  /** Unix socket supplied by the external @earendil-works/pi-server host. */
  piServerSocketPath?: string;
  metadata?: MetadataStore;
  sessions?: SessionIndex;
  registry?: RuntimeRegistry;
  usage?: UsageProvider;
  push?: PushSender;
  /** Bounded replay and subscriber memory for shell/session feeds. */
  feedReplayCount?: number;
  feedReplayBytes?: number;
  feedQueueCount?: number;
  feedQueueBytes?: number;
  /** Idle session-feed eviction; transport inactivity uses the locked tRPC constant. */
  feedInactivityMs?: number;
}

export interface DashboardConfiguration {
  readonly host: string;
  port: number;
  readonly stateDir: string;
  readonly token: string;
  readonly socketPath: string;
  readonly experimentalPiServer: boolean;
  readonly piServerSocketPath?: string;
  readonly origins: string[];
  readonly feedReplayCount: number;
  readonly feedReplayBytes: number;
  readonly feedQueueCount: number;
  readonly feedQueueBytes: number;
  readonly feedInactivityMs: number;
}

/** All non-transport collaborators assembled by the manual daemon root. */
export interface DashboardDependencies {
  readonly configuration: DashboardConfiguration;
  readonly metadata: MetadataStore;
  readonly orchestration: SqliteOrchestrationRepository;
  readonly sessions: SessionIndex;
  readonly sesh: SeshAdapter;
  readonly tmux: TmuxAdapter;
  readonly runtimeProvider: AgentRuntimeProvider;
  readonly usage: UsageProvider;
  push: PushSender;
  readonly pushConfigured: boolean;
  readonly shellFeed: ShellFeed;
  readonly sessionFeeds: SessionFeedRegistry;
  readonly registry: RuntimeRegistry;
  readonly manager: RuntimeManager;
  readonly orchestrationService: OrchestrationService;
  readonly application: DashboardApplication;
}

/** Small mutable relay used to close composition-time callback cycles. */
export class ChangeRelay<T> {
  private listener: ((value: T) => void) | undefined;

  connect(listener: (value: T) => void): void {
    this.listener = listener;
  }

  publish(value: T): void {
    this.listener?.(value);
  }
}

export function sessionDirectory(options: DashboardServerOptions): string {
  return (
    options.sessionDir ??
    process.env.PI_SESSION_DIR ??
    path.join(process.env.HOME ?? process.cwd(), '.pi', 'agent', 'sessions')
  );
}

export function delegateSessionDirectory(
  options: DashboardServerOptions,
): string {
  return (
    options.delegateSessionDir ??
    process.env.PI_DELEGATE_SESSION_DIR ??
    path.join(path.dirname(sessionDirectory(options)), '.delegate-sessions')
  );
}
