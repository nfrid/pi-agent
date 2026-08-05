import path from 'node:path';
import type { DashboardApplication } from './application/dashboard-application.js';
import type { DashboardEventStream } from './event-stream.js';
import type { MetadataStore } from './metadata.js';
import type { PushSender } from './push.js';
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
  sesh?: SeshAdapter;
  tmux?: TmuxAdapter;
  metadata?: MetadataStore;
  sessions?: SessionIndex;
  registry?: RuntimeRegistry;
  usage?: UsageProvider;
  push?: PushSender;
  /** Maximum number of daemon events retained for SSE replay. */
  eventBufferSize?: number;
  sseHeartbeatMs?: number;
  sseBufferBytes?: number;
}

export interface DashboardConfiguration {
  readonly host: string;
  port: number;
  readonly stateDir: string;
  readonly token: string;
  readonly socketPath: string;
  readonly origins: string[];
  readonly sseHeartbeatMs: number;
  readonly sseBufferBytes: number;
}

/** All non-transport collaborators assembled by the manual daemon root. */
export interface DashboardDependencies {
  readonly configuration: DashboardConfiguration;
  readonly metadata: MetadataStore;
  readonly sessions: SessionIndex;
  readonly sesh: SeshAdapter;
  readonly tmux: TmuxAdapter;
  readonly usage: UsageProvider;
  push: PushSender;
  readonly pushConfigured: boolean;
  readonly eventStream: DashboardEventStream;
  readonly registry: RuntimeRegistry;
  readonly manager: RuntimeManager;
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
