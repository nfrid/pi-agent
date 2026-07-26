import { createHash } from 'node:crypto';

/** Hex sha256 of the given bytes or UTF-8 string. */
export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
