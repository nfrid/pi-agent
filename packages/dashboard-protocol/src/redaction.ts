import type { BridgeEvent } from './schemas.js';
import { isRecord } from './utils.js';

export function redactImageData(value: unknown): unknown {
  if (
    typeof value === 'string' &&
    /^data:image\/[a-z0-9.+-]+;base64,/iu.test(value)
  )
    return '[image data omitted]';
  if (Array.isArray(value)) return value.map(redactImageData);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'data' && (value.type === 'image' || value.type === 'base64'))
      continue;
    if (
      key === 'source' &&
      isRecord(item) &&
      value.type === 'image' &&
      item.type === 'base64'
    ) {
      const { data: _data, ...source } = item;
      result.source = { ...source, omitted: true };
      continue;
    }
    result[key] = redactImageData(item);
  }
  if ((value.type === 'image' || value.type === 'base64') && 'data' in value)
    result.omitted = true;
  return result;
}

/** Defense-in-depth redaction for untrusted runtime bridge events. */
export function redactBridgeEvent(event: BridgeEvent): BridgeEvent {
  return redactImageData(event) as BridgeEvent;
}
