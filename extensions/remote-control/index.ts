import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { defineExtension } from '../shared/runtime/extension';
import { compactWithDashboardCancellation } from './compaction-shim';
import {
  directString,
  directValue,
  eventRecord,
  LiveEventNormalizer,
  shouldForwardLiveMessage,
} from './live-event-normalizer';
import {
  createRemoteControlRuntime,
  emitAgentSettlement,
  emitState,
  flushQueueDrafts,
} from './runtime';
import { sessionSnapshot } from './runtime-snapshot-adapter';

export type { BridgeClientOptions } from './bridge-client';
// Focused module exports are re-exported here to preserve the original test and
// extension import surface while the registration entrypoint stays small.
export {
  BRIDGE_COMMAND_QUEUE_LIMIT,
  BridgeClient,
} from './bridge-client';
export {
  dispatchDashboardInput,
  expandDashboardInput,
} from './command-adapter';
export { dispatchDashboardCommand } from './command-dispatcher';
export {
  LiveEventNormalizer,
  shouldForwardLiveMessage,
  withoutOpaqueData,
} from './live-event-normalizer';
export { QueueDraftStore } from './queue-draft-store';
export type { RemoteControlRuntime } from './runtime';
export {
  createRemoteControlRuntime,
  emitAgentSettlement,
  flushQueueDrafts,
} from './runtime';
export {
  composerCommandsSnapshot,
  modelCatalogSnapshot,
  thinkingLevelsSnapshot,
} from './runtime-snapshot-adapter';

export function emitCompactionStarted(
  runtime: import('./runtime').RemoteControlRuntime,
  ctx: ExtensionContext,
): void {
  emitState(runtime, ctx, 'compacting');
}

export function emitCompactionCompleted(
  runtime: import('./runtime').RemoteControlRuntime,
  ctx: ExtensionContext,
): void {
  runtime.setContext(ctx);
  if (!runtime.isCurrent(ctx)) return;
  runtime.client.sendEvent({
    type: 'session.snapshot',
    session: sessionSnapshot(ctx),
  });
  emitState(runtime, ctx);
}

export function shutdownRemoteControlRuntime(
  runtime: import('./runtime').RemoteControlRuntime,
  event: { reason: string },
  ctx: ExtensionContext,
  stopSteeringUpdates: () => void,
): void {
  stopSteeringUpdates();
  const announcesTermination =
    event.reason === 'quit' || event.reason === 'reload';
  const wasCurrent = runtime.isCurrent(ctx);
  if (announcesTermination && wasCurrent)
    runtime.client.sendEvent({
      type: 'runtime.goodbye',
      reason: event.reason,
    });
  runtime.clearContext(ctx);
  if (wasCurrent && !announcesTermination)
    runtime.client.sendEvent({
      type: 'runtime.stateChanged',
      state: 'idle',
      snapshot: {
        liveState: 'idle',
        pendingInteractions: [],
        queueDrafts: [],
        extensionSurfaces: [],
      },
    });
  // Pi tears down the entire extension runtime for every session replacement,
  // not only quit/reload. Leaving this bridge alive captures the old `pi` and
  // command context, which become stale as soon as the replacement is bound.
  runtime.client.stop();
}

type GenericEventAPI = {
  on(
    event: string,
    handler: (event: unknown, ctx: ExtensionContext) => void,
  ): void;
};
function onTransportEvent(
  pi: ExtensionAPI,
  event: string,
  handler: (event: unknown, ctx: ExtensionContext) => void,
): void {
  (pi as unknown as GenericEventAPI).on(event, handler);
}

export default defineExtension('remote-control', (pi) => {
  const runtime = createRemoteControlRuntime(pi);
  if (!runtime) return;
  const stopSteeringUpdates = pi.events.on(
    'steering-message:marked',
    (value) => {
      const update = eventRecord(value);
      const message = eventRecord(directValue(update, 'message'));
      const sessionId = directString(update, 'sessionId');
      if (!message || !sessionId) return;
      runtime.client.sendEvent({
        type: 'message.updated',
        sessionId,
        // Marker delivery may run after another message has become active, so
        // derive the steering update's identity independently from its exact
        // persisted timestamp instead of borrowing the active stream ID.
        message: new LiveEventNormalizer().normalizeMessage('updated', {
          message: { ...message, data: { deliveryMode: 'steer' } },
        }),
      });
    },
  );
  const onCurrentTransportEvent = (
    event: string,
    handler: (value: unknown, ctx: ExtensionContext) => void,
  ) =>
    onTransportEvent(pi, event, (value, ctx) => {
      if (!runtime.isCurrent(ctx)) return;
      runtime.setContext(ctx, false);
      if (runtime.isCurrent(ctx)) handler(value, ctx);
    });

  pi.on('session_start', (_event, ctx) => {
    runtime.setContext(ctx);
    if (!runtime.isCurrent(ctx)) return;
    runtime.client.start();
    runtime.client.sendEvent({
      type: 'session.snapshot',
      session: sessionSnapshot(ctx),
    });
    // Session replacement clears dashboard-owned drafts in setContext; publish
    // that empty/current set even when the bridge connection is reused.
    emitState(runtime, ctx);
  });
  pi.on('session_info_changed', (_event, ctx) => {
    runtime.setContext(ctx);
    if (!runtime.isCurrent(ctx)) return;
    runtime.client.sendEvent({
      type: 'session.changed',
      session: sessionSnapshot(ctx),
    });
  });
  pi.on('session_tree', (_event, ctx) => {
    runtime.setContext(ctx);
    if (!runtime.isCurrent(ctx)) return;
    runtime.client.sendEvent({
      type: 'session.snapshot',
      session: sessionSnapshot(ctx),
    });
  });
  pi.on('session_before_compact', async (event, ctx) => {
    emitCompactionStarted(runtime, ctx);
    event.signal.addEventListener('abort', () => emitState(runtime, ctx), {
      once: true,
    });
    const result = await compactWithDashboardCancellation(event, ctx);
    if (result.cancel) emitState(runtime, ctx);
    return result;
  });
  pi.on('session_compact', (_event, ctx) => {
    emitCompactionCompleted(runtime, ctx);
  });
  pi.on('before_agent_start', (_event, ctx) => {
    if (!runtime.isCurrent(ctx)) return;
    if (!runtime.isCurrent(ctx)) return;
    emitState(runtime, ctx, 'working');
  });
  pi.on('agent_start', (_event, ctx) => emitState(runtime, ctx));
  pi.on('turn_end', (_event, ctx) => {
    flushQueueDrafts(runtime, pi, ctx, 'steer');
  });
  pi.on('agent_settled', (_event, ctx) => {
    emitAgentSettlement(runtime, ctx);
  });
  pi.on('agent_end', (_event, ctx) => {
    if (!flushQueueDrafts(runtime, pi, ctx, 'followUp'))
      emitState(runtime, ctx);
  });
  onCurrentTransportEvent('message_start', (event, ctx) => {
    if (!shouldForwardLiveMessage(event)) return;
    runtime.client.sendEvent({
      type: 'message.started',
      sessionId: ctx.sessionManager.getSessionId(),
      message: runtime.eventNormalizer.normalizeMessage('started', event),
    });
  });
  onCurrentTransportEvent('message_update', (event, ctx) => {
    if (!shouldForwardLiveMessage(event)) return;
    runtime.client.sendEvent({
      type: 'message.updated',
      sessionId: ctx.sessionManager.getSessionId(),
      message: runtime.eventNormalizer.normalizeMessage('updated', event),
    });
  });
  onCurrentTransportEvent('message_end', (event, ctx) => {
    if (!shouldForwardLiveMessage(event)) return;
    runtime.client.sendEvent({
      type: 'message.finished',
      sessionId: ctx.sessionManager.getSessionId(),
      message: runtime.eventNormalizer.normalizeMessage('finished', event),
    });
  });
  onCurrentTransportEvent('tool_execution_start', (event, ctx) =>
    runtime.client.sendEvent({
      type: 'tool.started',
      sessionId: ctx.sessionManager.getSessionId(),
      tool: runtime.eventNormalizer.normalizeTool('started', event),
    }),
  );
  onCurrentTransportEvent('tool_execution_update', (event, ctx) =>
    runtime.client.sendEvent({
      type: 'tool.updated',
      sessionId: ctx.sessionManager.getSessionId(),
      tool: runtime.eventNormalizer.normalizeTool('updated', event),
    }),
  );
  onCurrentTransportEvent('tool_execution_end', (event, ctx) =>
    runtime.client.sendEvent({
      type: 'tool.finished',
      sessionId: ctx.sessionManager.getSessionId(),
      tool: runtime.eventNormalizer.normalizeTool('finished', event),
    }),
  );
  onCurrentTransportEvent('model_select', (_event, ctx) =>
    emitState(runtime, ctx),
  );
  onCurrentTransportEvent('thinking_level_select', (_event, ctx) =>
    emitState(runtime, ctx),
  );
  onCurrentTransportEvent('queue_update', (_event, ctx) =>
    emitState(runtime, ctx),
  );
  pi.on('session_shutdown', (event, ctx) => {
    shutdownRemoteControlRuntime(runtime, event, ctx, stopSteeringUpdates);
  });
});
