import {
  type NormalizedMessagePayload,
  NormalizedMessagePayloadSchema,
  type NormalizedToolPayload,
  NormalizedToolPayloadSchema,
  parseSchema,
  tryParseSchema,
} from '@pi-dashboard/protocol';

export function tryParseNormalizedMessagePayload(
  value: unknown,
): NormalizedMessagePayload | undefined {
  return tryParseSchema(NormalizedMessagePayloadSchema, value);
}

export function tryParseNormalizedToolPayload(
  value: unknown,
): NormalizedToolPayload | undefined {
  return tryParseSchema(NormalizedToolPayloadSchema, value);
}

export function parseNormalizedMessagePayload(
  value: unknown,
): NormalizedMessagePayload {
  return parseSchema(
    NormalizedMessagePayloadSchema,
    value,
    'normalized message payload',
  );
}

export function parseNormalizedToolPayload(
  value: unknown,
): NormalizedToolPayload {
  return parseSchema(
    NormalizedToolPayloadSchema,
    value,
    'normalized tool payload',
  );
}
