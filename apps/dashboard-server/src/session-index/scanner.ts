import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  activityEntryFromRaw,
  type TranscriptEntry,
} from '@pi-dashboard/activity-model';
import {
  type CodexServiceTier,
  isRecord,
  redactImageData,
  type SessionOutlineLandmark,
} from '@pi-dashboard/protocol';

export interface SessionLineDescriptor {
  /** Logical ordinal among valid, non-empty JSONL entries. */
  readonly ordinal: number;
  /** Physical UTF-8 byte boundaries, including the line ending at `end`. */
  readonly start: number;
  readonly end: number;
  /** Size used by the redacted history transport budget. */
  readonly outputBytes: number;
  /** SHA-256 of the exact physical bytes before this descriptor. */
  readonly prefixHash: string;
  readonly id?: string;
  readonly parentId?: unknown;
  readonly type?: string;
  readonly outlineId?: string;
  readonly outlineKind?: SessionOutlineLandmark['kind'];
  readonly outlineLabel?: string;
  readonly timestamp?: number | string;
  readonly userMessageAt?: number;
  readonly resume?: {
    readonly model?: { readonly provider: string; readonly model: string };
    readonly thinking?: string;
    readonly serviceTier?: CodexServiceTier | null;
    readonly contextTokens?: number;
  };
  readonly activity: TranscriptEntry;
}

export interface SessionFileVersion {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
}

interface SessionScanFileVersion extends SessionFileVersion {
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
}

export interface SessionScanResult {
  readonly header?: Record<string, unknown>;
  readonly descriptors: readonly SessionLineDescriptor[];
  readonly prefixHashes: ReadonlyMap<number, string>;
  readonly byId: ReadonlyMap<string, SessionLineDescriptor>;
  readonly latestEntryId?: string;
  readonly fileHash: string;
  readonly fileVersion: SessionScanFileVersion;
  readonly firstUserEntry?: unknown;
  readonly sawSessionInfo: boolean;
  readonly name?: string;
}

export const HISTORY_PAGE_BYTES = 384 * 1024;
export const INDEX_SCAN_CHUNK_BYTES = 64 * 1024;
export const INDEX_MAX_LINE_BYTES = 32 * 1024 * 1024;

export class SessionFileChangedError extends Error {
  constructor() {
    super('Session file changed while resolving its latest branch.');
  }
}

function isJsonlWhitespaceByte(byte: number): boolean {
  return (
    byte === 0x09 ||
    byte === 0x0b ||
    byte === 0x0c ||
    byte === 0x0d ||
    byte === 0x20
  );
}

function isBlankJsonlLine(line: Uint8Array): boolean {
  for (const byte of line) if (!isJsonlWhitespaceByte(byte)) return false;
  return true;
}

export function compactOutlineText(
  value: unknown,
  limit = 220,
): string | undefined {
  if (typeof value === 'string') {
    const text = value.replace(/\s+/gu, ' ').trim();
    return text ? text.slice(0, limit) : undefined;
  }
  if (Array.isArray(value)) {
    for (const part of value) {
      const text = compactOutlineText(part, limit);
      if (text) return text;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  return compactOutlineText(value.text ?? value.content, limit);
}

export function outlineIdentityId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const message = isRecord(value.message) ? value.message : value;
  const candidateId =
    typeof message.messageId === 'string'
      ? message.messageId
      : typeof message.id === 'string'
        ? message.id
        : typeof value.id === 'string'
          ? value.id
          : undefined;
  return candidateId !== undefined &&
    candidateId.length > 0 &&
    candidateId.length <= 256 &&
    ![...candidateId].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
    ? candidateId
    : undefined;
}

export function timestampNumber(value: unknown): number | undefined {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function outlineFields(
  value: unknown,
  activity: TranscriptEntry,
): Pick<
  SessionLineDescriptor,
  'outlineId' | 'outlineKind' | 'outlineLabel' | 'timestamp'
> {
  if (!isRecord(value)) return {};
  const message = isRecord(value.message) ? value.message : value;
  const timestamp = message.timestamp ?? value.timestamp;
  const timestampField =
    typeof timestamp === 'number' || typeof timestamp === 'string'
      ? { timestamp }
      : {};
  const outlineId = outlineIdentityId(value);
  const identityField = outlineId === undefined ? {} : { outlineId };
  if (message.role === 'user') {
    return {
      ...identityField,
      outlineKind: 'user',
      outlineLabel:
        compactOutlineText(message.content) ??
        compactOutlineText(value.content) ??
        'User turn',
      ...timestampField,
    };
  }
  if (activity.kind === 'assistant' && activity.titleKind === 'preamble')
    return {
      ...identityField,
      outlineKind: 'activity',
      outlineLabel: compactOutlineText(activity.title) ?? 'Agent activity',
      ...timestampField,
    };
  return timestampField;
}

function resumeFromRawEntry(value: unknown): SessionLineDescriptor['resume'] {
  if (!isRecord(value)) return undefined;
  if (value.type === 'model_change') {
    const provider = value.provider;
    const model = value.modelId;
    return typeof provider === 'string' && typeof model === 'string'
      ? { model: { provider, model } }
      : undefined;
  }
  if (value.type === 'thinking_level_change') {
    return typeof value.thinkingLevel === 'string'
      ? { thinking: value.thinkingLevel }
      : undefined;
  }
  if (
    value.type === 'custom' &&
    value.customType === 'codex-service-tier' &&
    isRecord(value.data)
  ) {
    const tier = value.data.tier;
    return tier === 'fast' || tier === 'ultrafast'
      ? { serviceTier: tier }
      : { serviceTier: null };
  }
  if (value.type !== 'message' || !isRecord(value.message)) return undefined;
  if (value.message.role !== 'assistant') return undefined;
  const provider = value.message.provider;
  const model = value.message.model;
  const usage = isRecord(value.message.usage) ? value.message.usage : undefined;
  const totalTokens = usage?.totalTokens;
  return {
    ...(typeof provider === 'string' && typeof model === 'string'
      ? { model: { provider, model } }
      : {}),
    ...(typeof totalTokens === 'number' &&
    Number.isFinite(totalTokens) &&
    totalTokens >= 0
      ? { contextTokens: totalTokens }
      : {}),
  };
}

function descriptorFromRawEntry(
  parsed: unknown,
  ordinal: number,
  start: number,
  end: number,
  prefixHash: string,
  isHeader: boolean,
): SessionLineDescriptor {
  const entry = redactImageData(parsed);
  const activity = activityEntryFromRaw(parsed);
  const resume = isHeader ? undefined : resumeFromRawEntry(parsed);
  return {
    ordinal,
    start,
    end,
    outputBytes: Math.min(
      Buffer.byteLength(JSON.stringify(entry) ?? ''),
      HISTORY_PAGE_BYTES,
    ),
    prefixHash,
    ...(isRecord(parsed) && typeof parsed.id === 'string'
      ? { id: parsed.id }
      : {}),
    ...(isRecord(parsed) && Object.hasOwn(parsed, 'parentId')
      ? { parentId: parsed.parentId }
      : {}),
    ...(isHeader
      ? { type: 'session' as const }
      : {
          ...(isRecord(parsed) &&
          parsed.type === 'message' &&
          isRecord(parsed.message) &&
          parsed.message.role === 'user' &&
          timestampNumber(parsed.message.timestamp ?? parsed.timestamp) !==
            undefined
            ? {
                userMessageAt: timestampNumber(
                  parsed.message.timestamp ?? parsed.timestamp,
                ),
              }
            : {}),
          ...(isRecord(parsed) && typeof parsed.type === 'string'
            ? { type: parsed.type }
            : {}),
          ...(resume ? { resume } : {}),
        }),
    activity,
    ...outlineFields(parsed, activity),
  };
}

/** Scan one already path-validated JSONL file without publishing catalogue state. */
export async function scanSessionFile(
  file: string,
  proofOffsets: readonly number[] = [],
  onPendingBytes?: (bytes: number) => void,
): Promise<SessionScanResult> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const descriptors: SessionLineDescriptor[] = [];
    const prefixHashes = new Map<number, string>();
    const byId = new Map<string, SessionLineDescriptor>();
    const fullHash = createHash('sha256');
    const checkpoints = [...new Set([0, ...proofOffsets])]
      .filter((offset) => Number.isSafeInteger(offset) && offset >= 0)
      .sort((left, right) => left - right);
    let checkpointIndex = 0;
    prefixHashes.set(0, fullHash.copy().digest('hex'));
    let header: Record<string, unknown> | undefined;
    let name: string | undefined;
    let sawSessionInfo = false;
    let firstUserEntry: unknown;
    let latestEntryId: string | undefined;
    let ordinal = 0;
    let offset = 0;
    const updateRawPrefix = (rawLine: Buffer, start: number): void => {
      let consumed = 0;
      while (checkpointIndex < checkpoints.length) {
        const checkpoint = checkpoints[checkpointIndex];
        if (checkpoint === undefined || checkpoint >= start + rawLine.length)
          break;
        if (checkpoint < start) {
          checkpointIndex += 1;
          continue;
        }
        const length = checkpoint - start - consumed;
        if (length > 0)
          fullHash.update(rawLine.subarray(consumed, consumed + length));
        consumed += Math.max(0, length);
        prefixHashes.set(checkpoint, fullHash.copy().digest('hex'));
        checkpointIndex += 1;
      }
      if (consumed < rawLine.length)
        fullHash.update(rawLine.subarray(consumed));
      prefixHashes.set(start + rawLine.length, fullHash.copy().digest('hex'));
    };
    const processLine = (rawLine: Buffer): void => {
      const start = offset;
      const end = start + rawLine.length;
      const newline = rawLine.at(-1) === 0x0a;
      const content = rawLine.subarray(
        0,
        newline ? rawLine.length - 1 : rawLine.length,
      );
      const withoutCr =
        content.at(-1) === 0x0d
          ? content.subarray(0, content.length - 1)
          : content;
      const prefixHash = fullHash.copy().digest('hex');
      if (!isBlankJsonlLine(withoutCr)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(decoder.decode(withoutCr)) as unknown;
        } catch {
          // Malformed and partial lines remain physical bytes but are not
          // logical descriptors.
          updateRawPrefix(rawLine, start);
          offset = end;
          return;
        }
        const isHeader = header === undefined;
        if (isHeader) {
          if (!isRecord(parsed) || parsed.type !== 'session')
            throw new Error('Invalid session header.');
          header = parsed;
        }
        const descriptor = descriptorFromRawEntry(
          parsed,
          ordinal,
          start,
          end,
          prefixHash,
          isHeader,
        );
        descriptors.push(descriptor);
        if (descriptor.id !== undefined) {
          byId.set(descriptor.id, descriptor);
          latestEntryId = descriptor.id;
        }
        if (!isHeader) {
          if (
            firstUserEntry === undefined &&
            isRecord(parsed) &&
            parsed.type === 'message' &&
            isRecord(parsed.message) &&
            parsed.message.role === 'user'
          )
            firstUserEntry = parsed;
          if (isRecord(parsed) && parsed.type === 'session_info') {
            sawSessionInfo = true;
            name =
              typeof parsed.name === 'string'
                ? parsed.name.trim() || undefined
                : undefined;
          }
        }
        ordinal += 1;
      }
      updateRawPrefix(rawLine, start);
      offset = end;
    };
    const chunk = Buffer.allocUnsafe(INDEX_SCAN_CHUNK_BYTES);
    let pending = Buffer.alloc(0);
    let pendingStart = 0;
    while (true) {
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (result.bytesRead === 0) break;
      pending =
        pending.length === 0
          ? Buffer.from(chunk.subarray(0, result.bytesRead))
          : Buffer.concat([pending, chunk.subarray(0, result.bytesRead)]);
      onPendingBytes?.(pending.length);
      while (true) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) break;
        const rawLine = Buffer.from(pending.subarray(0, newline + 1));
        offset = pendingStart;
        processLine(rawLine);
        pending = pending.subarray(newline + 1);
        pendingStart += rawLine.length;
      }
      if (pending.length > INDEX_MAX_LINE_BYTES)
        throw new Error('Session index line exceeds bounded scan limit.');
    }
    if (pending.length > 0) {
      offset = pendingStart;
      processLine(Buffer.from(pending));
    }
    const endStat = await handle.stat();
    if (
      endStat.dev !== stat.dev ||
      endStat.ino !== stat.ino ||
      endStat.size !== offset
    )
      throw new SessionFileChangedError();
    return {
      header,
      descriptors,
      prefixHashes,
      byId,
      latestEntryId,
      fileHash: fullHash.copy().digest('hex'),
      fileVersion: {
        dev: endStat.dev,
        ino: endStat.ino,
        size: endStat.size,
        mtimeMs: endStat.mtimeMs,
        ctimeMs: endStat.ctimeMs,
        birthtimeMs: endStat.birthtimeMs,
      },
      firstUserEntry,
      sawSessionInfo,
      name,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
