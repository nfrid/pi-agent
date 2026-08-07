/**
 * Provider-neutral runtime lifecycle contracts.
 *
 * The orchestration layer deals in IDs, paths, and opaque commands only. A
 * provider may use Pi, tmux, a server process, or another runtime without
 * exposing those native types here.
 */
export interface RuntimeLocation {
  /** Provider-owned stable location identifier. */
  readonly id: string;
  /** Provider-neutral location components for durable attachment metadata. */
  readonly sessionId?: string;
  readonly windowId?: string;
  readonly paneId?: string;
  /** Human-readable attach/display target, when one exists. */
  readonly displayTarget?: string;
}

export interface RuntimeBinding {
  readonly runtimeId: string;
  readonly location?: RuntimeLocation;
  readonly processId?: number;
}

export interface RuntimeStartInput {
  readonly runtimeId: string;
  readonly cwd: string;
  readonly name?: string;
  readonly socketPath: string;
  readonly launchToken: string;
  readonly identityToken: string;
  readonly sessionFile?: string;
  readonly model?: {
    readonly provider: string;
    readonly model: string;
    readonly thinking?: string;
  };
  /** Provider-neutral workspace/session hint; native provider values stay local. */
  readonly workspace: {
    readonly id: string;
    readonly name: string;
    readonly sessionId?: string;
    readonly active: boolean;
  };
}

export interface RuntimeAttachInput {
  readonly runtimeId: string;
  readonly location: RuntimeLocation;
}

export interface RuntimeCommand {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface RuntimeProviderEvent {
  readonly type: string;
  readonly runtimeId: string;
  readonly [key: string]: unknown;
}

export interface AgentRuntimeProvider {
  start(input: RuntimeStartInput): Promise<RuntimeBinding>;
  attach(input: RuntimeAttachInput): Promise<RuntimeBinding>;
  stop(binding: RuntimeBinding): Promise<void>;
  send(binding: RuntimeBinding, command: RuntimeCommand): Promise<void>;
  subscribe(
    binding: RuntimeBinding,
    listener: (event: RuntimeProviderEvent) => void,
  ): () => void;
}
