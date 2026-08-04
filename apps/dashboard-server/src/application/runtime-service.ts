import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import type { RuntimeManager } from '../runtime-manager.js';
import type { RuntimeRegistry } from '../runtime-registry.js';
import type { SessionIndex } from '../session-index.js';

/** Runtime commands exposed to browser adapters without transport types. */
export class RuntimeService {
  constructor(
    private readonly registry: RuntimeRegistry,
    private readonly manager: RuntimeManager,
    private readonly sessions: SessionIndex,
  ) {}

  snapshots(): RuntimeSnapshot[] {
    return this.registry.snapshots();
  }

  async launch(input: unknown) {
    return this.manager.launch(input);
  }

  async command(runtimeId: string, input: unknown): Promise<unknown> {
    return this.registry.sendCommand(runtimeId, input);
  }

  async stop(runtimeId: string, force = false): Promise<void> {
    await this.manager.stop(runtimeId, force);
  }

  async answerInteraction(
    interactionId: string,
    answer: unknown,
    cancel = false,
  ): Promise<unknown> {
    const runtime = this.registry
      .snapshots()
      .find((item) =>
        item.pendingInteractions.some(
          (interaction) => interaction.id === interactionId,
        ),
      );
    if (!runtime)
      throw new Error('Interaction is already resolved or offline.');
    const interaction = runtime.pendingInteractions.find(
      (item) => item.id === interactionId,
    );
    const actionId = cancel
      ? (interaction?.cancelActionId ?? 'ask-user.cancel')
      : (interaction?.answerActionId ?? 'ask-user.answer');
    const advertisesAction = runtime.capabilities?.manifests.some((manifest) =>
      manifest.actions.some((action) => action.id === actionId),
    );
    // Protocol-v1 runtimes retain the original operation. New runtimes use the
    // contribution envelope; both paths resolve the same broker winner.
    return this.registry.sendCommand(
      runtime.runtimeId,
      advertisesAction
        ? {
            type: 'action.invoke',
            actionId,
            input: cancel ? { interactionId } : { interactionId, answer },
          }
        : cancel
          ? { type: 'interaction.cancel', interactionId }
          : { type: 'interaction.answer', interactionId, answer },
    );
  }

  async renameSession(id: string, name: string): Promise<unknown> {
    const runtime = this.registry
      .snapshots()
      .find((item) => item.session.id === id && item.online !== false);
    if (runtime)
      return this.registry.sendCommand(runtime.runtimeId, {
        type: 'setSessionName',
        name,
      });
    return this.sessions.rename(id, name);
  }
}
