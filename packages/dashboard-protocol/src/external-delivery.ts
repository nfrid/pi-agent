import type { RuntimeCapabilitySnapshot } from '@pi-dashboard/extension-contributions';
import { MAX_ID } from './limits.js';
import { safeIdentifier } from './utils.js';

export const EXTERNAL_DELIVERY_CAPABILITY = 'remote-control.external-delivery';
export const EXTERNAL_STEERING_CAPABILITY = 'remote-control.external-steering';
export const EXTERNAL_DELIVERY_RECEIPT = 'external-delivery-receipt';
export type ExternalDeliveryReceipt = {
  version: 1;
  deliveryId: string;
  userEntryId: string;
};

/** Read only our hidden SDK entry, never a user message that resembles one. */
export function externalDeliveryReceipt(
  entry: unknown,
): ExternalDeliveryReceipt | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const value = entry as Record<string, unknown>;
  if (
    value.type !== 'custom' ||
    value.customType !== EXTERNAL_DELIVERY_RECEIPT ||
    !value.data ||
    typeof value.data !== 'object'
  )
    return undefined;
  const data = value.data as Record<string, unknown>;
  if (
    data.version !== 1 ||
    !safeIdentifier(data.deliveryId, MAX_ID) ||
    !safeIdentifier(data.userEntryId, MAX_ID)
  )
    return undefined;
  return {
    version: 1,
    deliveryId: data.deliveryId,
    userEntryId: data.userEntryId,
  };
}

export function supportsExternalSteering(
  runtime: { capabilities?: RuntimeCapabilitySnapshot } | undefined,
): boolean {
  return (
    runtime?.capabilities?.capabilities.some(
      (capability) =>
        capability.id === EXTERNAL_STEERING_CAPABILITY &&
        capability.version === '1' &&
        capability.available,
    ) === true
  );
}

export function supportsExternalDelivery(
  runtime: { capabilities?: RuntimeCapabilitySnapshot } | undefined,
  requireSessionFence = false,
): boolean {
  return (
    runtime?.capabilities?.capabilities.some(
      (capability) =>
        capability.id === EXTERNAL_DELIVERY_CAPABILITY &&
        (capability.version === '2' ||
          (!requireSessionFence && capability.version === '1')) &&
        capability.available,
    ) === true
  );
}
