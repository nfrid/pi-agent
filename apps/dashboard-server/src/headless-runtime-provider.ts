import type {
  AgentRuntimeProvider,
  RuntimeAttachInput,
  RuntimeBinding,
  RuntimeCommand,
  RuntimeProviderEvent,
  RuntimeStartInput,
} from '@pi-dashboard/protocol';
import { type HostStartInput, RuntimeHostClient } from './runtime-host.js';

/** Dashboard agent commands/events still use remote-control and bridge. */
export class HeadlessRuntimeProvider implements AgentRuntimeProvider {
  readonly requiresRegistration = true;
  private readonly host: RuntimeHostClient;

  constructor(
    readonly socketPath: string,
    options: { client?: RuntimeHostClient } = {},
  ) {
    this.host = options.client ?? new RuntimeHostClient(socketPath);
  }

  async start(input: RuntimeStartInput): Promise<RuntimeBinding> {
    const launch: HostStartInput = {
      runtimeId: input.runtimeId,
      cwd: input.cwd,
      ...(input.name ? { name: input.name } : {}),
      ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      socketPath: input.socketPath,
      launchToken: input.launchToken,
      identityToken: input.identityToken,
    };
    return this.host.start(launch);
  }

  async attach(input: RuntimeAttachInput): Promise<RuntimeBinding> {
    return this.host.attach(input);
  }

  async stop(binding: RuntimeBinding, force = false): Promise<void> {
    await this.host.stop(binding.runtimeId, force);
  }

  async send(
    _binding: RuntimeBinding,
    _command: RuntimeCommand,
  ): Promise<void> {
    // The bridge is the sole agent command path. The host must never become a
    // second protocol or command/event relay.
  }

  subscribe(
    _binding: RuntimeBinding,
    _listener: (event: RuntimeProviderEvent) => void,
  ): () => void {
    return () => undefined;
  }
}
