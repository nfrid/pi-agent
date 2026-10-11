import { randomUUID } from 'node:crypto';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type {
  ExtensionCapabilityContract,
  ExtensionManifest,
} from '@pi-dashboard/extension-contributions';
import { MAX_ID } from '@pi-dashboard/protocol/pi-runtime-protocol';
import { Type } from 'typebox';
import { getNativeSteeringController } from '../shared/runtime/native-steering';
import { expandDashboardInput } from './command-adapter';
import {
  withExternalSteering,
  withQueueSendObservation,
} from './external-delivery';
import type { QueueDraftStore, StoredQueueDraft } from './queue-draft-store';

export const NATIVE_STEERING_CAPABILITY_ID = 'remote-control.native-steering';
export const QUEUE_STEER_NOW_ACTION_ID = 'queue.steer-now';

const manifest: ExtensionManifest = {
  id: 'remote-control.native-steering',
  version: '1',
  title: 'Native queue steering',
  actions: [
    {
      id: QUEUE_STEER_NOW_ACTION_ID,
      title: 'Steer now',
      description: 'Send the current queue head through native steering.',
      inputSchema: Type.Object(
        {
          clientId: Type.String({ minLength: 1, maxLength: MAX_ID }),
          revision: Type.Integer({ minimum: 1 }),
          expectedSessionId: Type.String({ minLength: 1, maxLength: MAX_ID }),
        },
        { additionalProperties: false },
      ),
      availability: {
        requires: [NATIVE_STEERING_CAPABILITY_ID],
        liveStates: ['working'],
      },
      idempotent: false,
    },
  ],
  renderers: [],
};

type NativeActionHost = {
  getContext(): ExtensionContext | undefined;
  pi: ExtensionAPI;
  store: QueueDraftStore;
  isCurrent(ctx: ExtensionContext): boolean;
  publish(ctx: ExtensionContext): void;
};

function publishHandoff(
  host: NativeActionHost,
  ctx: ExtensionContext,
  draft: StoredQueueDraft,
  status: 'accepted' | 'entered' | 'failed' | 'uncertain',
  detail?: string,
) {
  if (
    !host.isCurrent(ctx) ||
    host.store.getSessionId() !== ctx.sessionManager.getSessionId()
  )
    return;
  host.store.resolveHandoff(draft, status, detail);
  host.publish(ctx);
}

export function nativeSteeringContribution(
  host: NativeActionHost,
): ExtensionCapabilityContract {
  const sessionId = host.store.getSessionId();
  if (!sessionId) throw new Error('Queue session is unavailable.');
  return {
    id: manifest.id,
    manifest,
    snapshotProvider: () => [
      {
        id: NATIVE_STEERING_CAPABILITY_ID,
        version: '1',
        available:
          getNativeSteeringController(sessionId)?.isAvailable() === true,
        summary: 'Native Responses steering is connected for this session.',
      },
    ],
    actionHandlers: {
      [QUEUE_STEER_NOW_ACTION_ID]: async (invocation) => {
        const input = invocation.input as {
          clientId: string;
          revision: number;
          expectedSessionId: string;
        };
        const ctx = host.getContext();
        if (!ctx)
          throw Object.assign(new Error('Pi session is not ready.'), {
            code: 'unavailable-action',
          });
        const sourceSession = ctx.sessionManager.getSessionId();
        const controller = getNativeSteeringController(sourceSession);
        if (
          !host.isCurrent(ctx) ||
          sourceSession !== input.expectedSessionId ||
          sourceSession !== sessionId ||
          ctx.isIdle() ||
          ctx.hasPendingMessages() ||
          host.store
            .listHandoffs()
            .some((item) =>
              ['handing-off', 'accepted', 'uncertain'].includes(item.status),
            ) ||
          !controller?.isAvailable()
        )
          throw Object.assign(
            new Error('Native steering is unavailable for this queue action.'),
            { code: 'unavailable-action' },
          );
        const branch = ctx.sessionManager.getLeafId();
        if (!branch)
          throw Object.assign(new Error('The source branch is unavailable.'), {
            code: 'orchestration-conflict',
          });
        const draft = host.store
          .list()
          .find(
            (item) =>
              item.clientId === input.clientId &&
              item.revision === input.revision,
          );
        if (!draft || draft.imageCount)
          throw Object.assign(
            new Error('The requested steer draft cannot be sent natively.'),
            { code: 'queue-conflict' },
          );
        const expandedText = expandDashboardInput(
          draft.text,
          host.pi.getCommands?.() ?? [],
        );
        const claimedDraft = host.store.claimSteerNow(
          input.clientId,
          input.revision,
        );
        if (!claimedDraft)
          throw Object.assign(
            new Error(
              'The requested revision is not the editable steer queue head.',
            ),
            { code: 'queue-conflict' },
          );
        host.publish(ctx);
        const deliveryId = `native:${randomUUID()}`;
        let callbackFailed = false;
        let callbackInvoked = false;
        try {
          const result = await controller.steer(expandedText, async () => {
            callbackInvoked = true;
            try {
              if (
                !host.isCurrent(ctx) ||
                ctx.sessionManager.getSessionId() !== sourceSession ||
                !ctx.sessionManager
                  .getBranch()
                  .some((entry) => entry.id === branch)
              )
                throw Object.assign(
                  new Error('The source session or branch changed.'),
                  { code: 'orchestration-conflict' },
                );
              await withExternalSteering(
                ctx,
                deliveryId,
                sourceSession,
                branch,
                async () => {
                  let resolveAdmission!: () => void;
                  let rejectAdmission!: (error: Error) => void;
                  const admission = new Promise<void>((resolve, reject) => {
                    resolveAdmission = resolve;
                    rejectAdmission = reject;
                  });
                  const { result: sent, observed } = withQueueSendObservation(
                    () =>
                      host.pi.sendUserMessage(expandedText, {
                        deliverAs: 'steer',
                      }),
                    (outcome) => {
                      if (outcome.status === 'accepted') resolveAdmission();
                      else rejectAdmission(new Error(outcome.detail));
                    },
                    () => publishHandoff(host, ctx, claimedDraft, 'entered'),
                  );
                  if (!observed)
                    throw new Error(
                      'Pi did not expose the native queue admission observer.',
                    );
                  await Promise.all([Promise.resolve(sent), admission]);
                },
              );
            } catch (error) {
              callbackFailed = true;
              throw error;
            }
          });
          if (
            callbackFailed ||
            result.status === 'unknown' ||
            (result.status === 'accepted' && !callbackInvoked)
          )
            publishHandoff(
              host,
              ctx,
              claimedDraft,
              'uncertain',
              result.status === 'accepted'
                ? callbackInvoked
                  ? 'Native acceptance callback failed.'
                  : 'Native controller accepted without queue admission.'
                : result.message,
            );
          else if (result.status === 'failed')
            publishHandoff(host, ctx, claimedDraft, 'failed', result.message);
          else publishHandoff(host, ctx, claimedDraft, 'accepted');
          return {
            accepted:
              result.status === 'accepted' &&
              callbackInvoked &&
              !callbackFailed,
            status: result.status,
            actionId: QUEUE_STEER_NOW_ACTION_ID,
          };
        } catch (error) {
          publishHandoff(
            host,
            ctx,
            claimedDraft,
            'uncertain',
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      },
    },
  };
}
