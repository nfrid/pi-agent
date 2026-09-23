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

/** Redact session image bytes while retaining a bounded lookup reference. */
export function redactSessionEntryImages(value: unknown): unknown {
  const redacted = redactImageData(value);
  if (!isRecord(value) || !isRecord(redacted)) return redacted;
  const entryId =
    typeof value.id === 'string' && value.id.length <= 512
      ? value.id
      : undefined;
  if (!entryId) return redacted;
  const rawMessage = isRecord(value.message) ? value.message : value;
  const safeMessage = isRecord(redacted.message) ? redacted.message : redacted;
  const rawResult = isRecord(rawMessage.result) ? rawMessage.result : undefined;
  const safeResult = isRecord(safeMessage.result)
    ? safeMessage.result
    : undefined;
  const rawContent = Array.isArray(rawMessage.content)
    ? rawMessage.content
    : Array.isArray(rawResult?.content)
      ? rawResult.content
      : undefined;
  const safeContent = Array.isArray(safeMessage.content)
    ? safeMessage.content
    : Array.isArray(safeResult?.content)
      ? safeResult.content
      : undefined;
  if (!rawContent || !safeContent) return redacted;

  let imageIndex = 0;
  for (let index = 0; index < rawContent.length; index += 1) {
    const rawPart = rawContent[index];
    const safePart = safeContent[index];
    if (
      !isRecord(rawPart) ||
      rawPart.type !== 'image' ||
      !isRecord(safePart) ||
      safePart.type !== 'image'
    )
      continue;
    const source = isRecord(rawPart.source) ? rawPart.source : undefined;
    const hasImageData =
      typeof rawPart.data === 'string' ||
      (source?.type === 'base64' && typeof source.data === 'string');
    if (hasImageData && imageIndex <= 3) {
      safeContent[index] = {
        ...safePart,
        sessionImageRef: { entryId, imageIndex },
      };
    }
    imageIndex += 1;
  }
  return redacted;
}

/** Defense-in-depth redaction for untrusted runtime bridge events. */
export function redactBridgeEvent(event: BridgeEvent): BridgeEvent {
  return redactImageData(event) as BridgeEvent;
}
