import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
} from '@earendil-works/pi-coding-agent';
import {
  EXTERNAL_DELIVERY_RECEIPT,
  type ExternalDeliveryReceipt,
  externalDeliveryReceipt,
} from '@pi-dashboard/protocol';

type Dispatch = {
  deliveryId: string;
  sessionId: string;
  sawUser: boolean;
  message?: MessageEndEvent['message'];
  recorded: boolean;
};
const dispatchScope = new AsyncLocalStorage<Dispatch>();

/** Async provenance, not the next message's text/order, identifies this input. */
export function withExternalDelivery<T>(
  ctx: ExtensionContext,
  deliveryId: string,
  send: () => T,
  expectedSessionId?: string,
): T {
  if (
    expectedSessionId !== undefined &&
    ctx.sessionManager.getSessionId() !== expectedSessionId
  )
    throw new Error(
      'The source session has been replaced; the old answer was not delivered.',
    );
  if (!ctx.isIdle() || ctx.hasPendingMessages())
    throw Object.assign(
      new Error(
        'External input requires an idle runtime with no queued messages.',
      ),
      { code: 'busy' },
    );
  if (
    ctx.sessionManager
      .getEntries()
      .some(
        (entry) => externalDeliveryReceipt(entry)?.deliveryId === deliveryId,
      )
  )
    throw new Error('This external delivery already has a persisted receipt.');
  return dispatchScope.run(
    {
      deliveryId,
      sessionId: ctx.sessionManager.getSessionId(),
      sawUser: false,
      recorded: false,
    },
    send,
  );
}

export function installExternalDeliveryReceipts(pi: ExtensionAPI): void {
  pi.on('message_end', (event, ctx) => {
    const dispatch = dispatchScope.getStore();
    if (!dispatch || dispatch.sawUser || event.message.role !== 'user') return;
    dispatch.sawUser = true;
    if (ctx.sessionManager.getSessionId() === dispatch.sessionId)
      dispatch.message = event.message;
  });
  pi.on('context', (_event, ctx) => {
    const dispatch = dispatchScope.getStore();
    if (
      !dispatch ||
      dispatch.recorded ||
      !dispatch.message ||
      ctx.sessionManager.getSessionId() !== dispatch.sessionId
    )
      return;
    // The SDK persists message_end after extension handlers. At context time
    // that exact native object has an entry ID. Never substitute text/timestamps
    // if this invariant changes: a missing receipt must fail closed at the API.
    const entries = ctx.sessionManager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === 'message' && entry.message === dispatch.message,
      );
    if (entries.length !== 1 || !entries[0]) return;
    pi.appendEntry<ExternalDeliveryReceipt>(EXTERNAL_DELIVERY_RECEIPT, {
      version: 1,
      deliveryId: dispatch.deliveryId,
      userEntryId: entries[0].id,
    });
    dispatch.recorded = true;
  });
}
