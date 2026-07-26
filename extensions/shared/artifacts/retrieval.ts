import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { resolveArtifact } from './storage';
import {
  type ArtifactMetadata,
  MAX_RESULT_BYTES,
  MAX_SEARCH_SCAN_BYTES,
  type ResolvedArtifact,
} from './types';

export const RETRIEVAL_MODES = [
  'metadata',
  'lines',
  'search',
  'json',
  'bytes',
] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

export interface RetrievalRequest {
  handle: string;
  mode: RetrievalMode;
  /** Line number for `lines`, byte offset for `bytes`. Both are 0-based. */
  offset?: number;
  limit?: number;
  query?: string;
  pointer?: string;
  beforeLines?: number;
  afterLines?: number;
}

/** Ceiling on the payload one retrieval may put into the context window. */
const PAYLOAD_BYTES = 48 * 1024;
const MAX_LINES = 1000;
const MAX_MATCHES = 100;
const MAX_CONTEXT_LINES = 20;

/** Truncate to at most `maximum` bytes without splitting a code point. */
function utf8Prefix(value: string, maximum = PAYLOAD_BYTES) {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximum) return { text: value, bytes: bytes.length };
  let end = maximum;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  const text = bytes.subarray(0, end).toString('utf8');
  return { text, bytes: Buffer.byteLength(text) };
}

interface Line {
  number: number;
  text: string;
  raw: string;
  startByte: number;
}

function linesOf(text: string): Line[] {
  if (!text) return [];
  const lines: Line[] = [];
  let start = 0;
  let startByte = 0;
  while (start < text.length) {
    let end = start;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++;
    let after = end;
    if (text[after] === '\r' && text[after + 1] === '\n') after += 2;
    else if (text[after] === '\r' || text[after] === '\n') after++;
    const raw = text.slice(start, after);
    lines.push({
      number: lines.length + 1,
      text: text.slice(start, end),
      raw,
      startByte,
    });
    start = after;
    startByte += Buffer.byteLength(raw);
  }
  return lines;
}

function assertTextual(metadata: ArtifactMetadata): void {
  if (metadata.encoding !== 'utf-8')
    throw new Error(
      'This mode needs a textual artifact; use mode="bytes" for exact base64',
    );
}

function bounded(value: number | undefined, fallback: number, ceiling: number) {
  return Math.min(ceiling, Math.max(1, Math.floor(value ?? fallback)));
}

function retrieveMetadata(artifact: ResolvedArtifact) {
  return { content: null, remainingBytes: artifact.bytes.length };
}

function retrieveBytes(artifact: ResolvedArtifact, request: RetrievalRequest) {
  const { bytes } = artifact;
  const offset = Math.min(
    bytes.length,
    Math.max(0, Math.floor(request.offset ?? 0)),
  );
  const wanted = bounded(request.limit, 32 * 1024, 32 * 1024);
  const selected = bytes.subarray(offset, offset + wanted);
  return {
    offset,
    encoding: 'base64' as const,
    content: selected.toString('base64'),
    remainingBytes: bytes.length - offset - selected.length,
  };
}

function retrieveLines(artifact: ResolvedArtifact, request: RetrievalRequest) {
  assertTextual(artifact.metadata);
  const lines = linesOf(artifact.bytes.toString('utf8'));
  const start = Math.min(
    lines.length,
    Math.max(0, Math.floor(request.offset ?? 0)),
  );
  const chosen = lines.slice(
    start,
    start + bounded(request.limit, 200, MAX_LINES),
  );
  // The byte cap can cut the tail short, so the caller is told how many whole
  // lines actually came back rather than how many were selected.
  const returned = utf8Prefix(chosen.map((line) => line.raw).join(''));
  const complete = chosen.filter(
    (line) =>
      line.startByte +
        Buffer.byteLength(line.raw) -
        (chosen[0]?.startByte ?? 0) <=
      returned.bytes,
  ).length;
  return {
    startLine: start + 1,
    returnedLines: complete,
    remainingLines: Math.max(0, lines.length - start - complete),
    content: returned.text,
    remainingBytes:
      artifact.bytes.length - (chosen[0]?.startByte ?? 0) - returned.bytes,
  };
}

function retrieveSearch(artifact: ResolvedArtifact, request: RetrievalRequest) {
  assertTextual(artifact.metadata);
  const query = request.query ?? '';
  if (!query || query.length > 1024)
    throw new Error('search requires a query of 1-1024 characters');
  // Large artifacts are scanned only up to a bound; the unscanned tail is
  // reported so the agent knows the match list may be incomplete.
  const { bytes } = artifact;
  let scanEnd = Math.min(bytes.length, MAX_SEARCH_SCAN_BYTES);
  while (
    scanEnd > 0 &&
    scanEnd < bytes.length &&
    (bytes[scanEnd] & 0xc0) === 0x80
  )
    scanEnd--;
  const lines = linesOf(bytes.subarray(0, scanEnd).toString('utf8'));
  const needle = query.toLowerCase();
  const matched = lines.filter((line) =>
    line.text.toLowerCase().includes(needle),
  );
  const before = Math.min(
    MAX_CONTEXT_LINES,
    Math.max(0, request.beforeLines ?? 0),
  );
  const after = Math.min(
    MAX_CONTEXT_LINES,
    Math.max(0, request.afterLines ?? 0),
  );

  const returned: Array<{
    startLine: number;
    matchLine: number;
    excerpt: string;
  }> = [];
  for (const match of matched.slice(0, MAX_MATCHES)) {
    const first = Math.max(0, match.number - 1 - before);
    const selected = lines.slice(
      first,
      Math.min(lines.length, match.number + after),
    );
    const excerpt = {
      matchLine: match.number,
      startLine: first + 1,
      excerpt: selected.map((line) => line.raw).join(''),
    };
    if (
      Buffer.byteLength(JSON.stringify([...returned, excerpt])) > PAYLOAD_BYTES
    )
      break;
    returned.push(excerpt);
  }
  return {
    totalMatches: matched.length,
    returnedMatches: returned.length,
    unscannedBytes: bytes.length - scanEnd,
    content: returned,
    remainingBytes: bytes.length - scanEnd,
  };
}

function decodePointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  if (!pointer.startsWith('/'))
    throw new Error('JSON pointer must be empty or start with /');
  let value = root;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (
      value === null ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, key)
    )
      throw new Error(`JSON pointer not found: ${pointer}`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function retrieveJson(artifact: ResolvedArtifact, request: RetrievalRequest) {
  assertTextual(artifact.metadata);
  const parsed = JSON.parse(artifact.bytes.toString('utf8')) as unknown;
  const selected = decodePointer(parsed, request.pointer ?? '');
  const full =
    typeof selected === 'string' ? selected : JSON.stringify(selected);
  const returned = utf8Prefix(full);
  return {
    pointer: request.pointer ?? '',
    content: returned.text,
    remainingBytes: Buffer.byteLength(full) - returned.bytes,
  };
}

const handlers: Record<
  RetrievalMode,
  (
    artifact: ResolvedArtifact,
    request: RetrievalRequest,
  ) => Record<string, unknown>
> = {
  metadata: retrieveMetadata,
  bytes: retrieveBytes,
  lines: retrieveLines,
  search: retrieveSearch,
  json: retrieveJson,
};

export async function retrieveArtifact(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  request: RetrievalRequest,
  root?: string,
): Promise<Record<string, unknown>> {
  const artifact = await resolveArtifact(ctx, request.handle, root);
  if (!artifact) throw new Error('Artifact handle not found in this session');
  return {
    metadata: artifact.metadata,
    mode: request.mode,
    totalBytes: artifact.bytes.length,
    ...handlers[request.mode](artifact, request),
  };
}

export function renderRetrievalResult(result: Record<string, unknown>): string {
  const rendered = JSON.stringify(result);
  if (Buffer.byteLength(rendered) > MAX_RESULT_BYTES)
    throw new Error('Internal result ceiling exceeded');
  return rendered;
}
