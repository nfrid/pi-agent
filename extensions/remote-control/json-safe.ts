import {
  MAX_FRAME_BYTES,
  redactImageData,
} from '@pi-dashboard/protocol/pi-runtime-protocol';

const MAX_JSON_PAYLOAD_BYTES = 460_000;

/** Clone a value through JSON with size and image-redaction bounds. */
export function jsonSafe(
  value: unknown,
  max = MAX_JSON_PAYLOAD_BYTES,
): unknown {
  try {
    const text = JSON.stringify(redactImageData(value));
    if (!text || Buffer.byteLength(text) > max) return null;
    return JSON.parse(text) as unknown;
  } catch {
    // Event schemas require the payload key to be present. Null is a valid,
    // bounded representation for an optional provider object that cannot be
    // cloned (for example, a cyclic or oversized value).
    return null;
  }
}

export { MAX_FRAME_BYTES, MAX_JSON_PAYLOAD_BYTES };
