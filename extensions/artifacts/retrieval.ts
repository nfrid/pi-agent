import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { selectTextRange } from '../shared/text-selection';
import { resolveArtifact } from './storage';
import { MAX_RESULT_BYTES, MAX_SEARCH_SCAN_BYTES } from './types';
import { utf8Prefix, utf8Suffix } from './utf8-boundary';

export const RETRIEVAL_MODES = [
  'metadata',
  'bytes',
  'lines',
  'head',
  'tail',
  'literal',
  'regex',
  'heading',
  'json',
] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

export interface RetrievalRequest {
  handle: string;
  mode: RetrievalMode;
  offset?: number;
  limit?: number;
  query?: string;
  heading?: string;
  pointer?: string;
  field?: string;
  beforeLines?: number;
  afterLines?: number;
}

const PAYLOAD_BYTES = 48 * 1024;
const MAX_MATCHES = 100;
const MAX_CONTEXT_LINES = 20;

interface Line {
  number: number;
  text: string;
  raw: string;
  startByte: number;
  endByte: number;
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
    const rawBytes = Buffer.byteLength(raw);
    lines.push({
      number: lines.length + 1,
      text: text.slice(start, end),
      raw,
      startByte,
      endByte: startByte + rawBytes,
    });
    start = after;
    startByte += rawBytes;
  }
  return lines;
}

function prefix(value: string, maximum = PAYLOAD_BYTES) {
  return utf8Prefix(value, maximum);
}

function suffix(value: string, maximum = PAYLOAD_BYTES) {
  return utf8Suffix(value, maximum);
}

function accounting(
  totalBytes: number,
  sourceSelectedBytes: number,
  returnedBytes: number,
  content: unknown,
  sourceRemainingBytes = Math.max(0, totalBytes - sourceSelectedBytes),
  selectorResultBytes = sourceSelectedBytes,
) {
  return {
    totalBytes,
    sourceSelectedBytes,
    selectorResultBytes,
    returnedBytes,
    selectionRemainingBytes: Math.max(0, selectorResultBytes - returnedBytes),
    sourceRemainingBytes,
    content,
  };
}

function safeRegex(source: string): RegExp {
  if (!source || source.length > 256)
    throw new Error('Regex must be 1-256 characters');
  let inClass = false;
  let escaped = false;
  for (const character of source) {
    if (escaped) {
      if (/^[1-9]$/.test(character))
        throw new Error('Regex backreferences are not allowed');
      escaped = false;
      continue;
    }
    if (character === '\\') escaped = true;
    else if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (!inClass && '()*+?{}'.includes(character))
      throw new Error('Regex groups and repetition are not allowed');
  }
  if (escaped || inClass) throw new Error('Invalid regex');
  return new RegExp(source, 'giu');
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

function contextCount(value: number | undefined): number {
  return Math.min(MAX_CONTEXT_LINES, Math.max(0, Math.floor(value ?? 0)));
}

export async function retrieveArtifact(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  request: RetrievalRequest,
  root?: string,
): Promise<Record<string, unknown>> {
  const artifact = await resolveArtifact(ctx, request.handle, root);
  if (!artifact) throw new Error('Artifact handle not found in this session');
  const { bytes, metadata } = artifact;
  if (request.mode === 'metadata')
    return { metadata, ...accounting(bytes.length, 0, 0, null, bytes.length) };

  const requestedLimit = Math.max(1, Math.floor(request.limit ?? 200));
  if (request.mode === 'bytes') {
    const offset = Math.min(
      bytes.length,
      Math.max(0, Math.floor(request.offset ?? 0)),
    );
    const sourceCount = Math.min(requestedLimit, bytes.length - offset);
    const returnedCount = Math.min(sourceCount, 36 * 1024);
    const selected = bytes.subarray(offset, offset + returnedCount);
    return {
      metadata,
      offset,
      encoding: 'base64',
      ...accounting(
        bytes.length,
        sourceCount,
        selected.length,
        selected.toString('base64'),
        bytes.length - sourceCount,
      ),
    };
  }

  if (metadata.encoding !== 'utf-8')
    throw new Error(
      'Textual selectors reject binary artifacts; use mode="bytes" for exact base64',
    );

  if (request.mode === 'head' || request.mode === 'tail') {
    const wanted = Math.min(requestedLimit, bytes.length);
    let start = request.mode === 'head' ? 0 : bytes.length - wanted;
    let end = request.mode === 'head' ? wanted : bytes.length;
    if (request.mode === 'head') {
      while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80)
        end--;
    } else {
      while (start < end && (bytes[start] & 0xc0) === 0x80) start++;
    }
    const full = bytes.subarray(start, end).toString('utf8');
    const returned =
      request.mode === 'head'
        ? { ...prefix(full), omittedBytes: 0 }
        : suffix(full);
    return {
      metadata,
      offset: start,
      returnedOffset: start + returned.omittedBytes,
      selectionTruncatedAt: request.mode === 'head' ? 'end' : 'start',
      ...accounting(bytes.length, end - start, returned.bytes, returned.text),
    };
  }

  const text = bytes.toString('utf8');
  const lines = linesOf(text);
  if (request.mode === 'lines') {
    const start = Math.min(
      lines.length,
      Math.max(0, Math.floor(request.offset ?? 0)),
    );
    const chosen = lines.slice(start, start + Math.min(requestedLimit, 1000));
    const full = chosen.map((line) => line.raw).join('');
    const returned = prefix(full);
    const sourceOffset = chosen[0]?.startByte ?? bytes.length;
    return {
      metadata,
      sourceOffset,
      startLine: start + 1,
      requestedLines: requestedLimit,
      lineLimit: 1000,
      sourceSelectedLines: chosen.length,
      returnedCompleteLines: chosen.filter(
        (line) => line.endByte - sourceOffset <= returned.bytes,
      ).length,
      remainingLines: Math.max(0, lines.length - start - chosen.length),
      ...accounting(
        bytes.length,
        Buffer.byteLength(full),
        returned.bytes,
        returned.text,
      ),
    };
  }

  if (request.mode === 'literal' || request.mode === 'regex') {
    const scanBytes = Math.min(bytes.length, MAX_SEARCH_SCAN_BYTES);
    let scanEnd = scanBytes;
    while (
      scanEnd > 0 &&
      scanEnd < bytes.length &&
      (bytes[scanEnd] & 0xc0) === 0x80
    )
      scanEnd--;
    const scanLines = linesOf(bytes.subarray(0, scanEnd).toString('utf8'));
    const query = request.query ?? '';
    if (!query || query.length > 1024)
      throw new Error('Search query must be 1-1024 characters');
    const regex = request.mode === 'regex' ? safeRegex(query) : undefined;
    const matched = scanLines.filter((line) => {
      if (!regex) return line.text.includes(query);
      regex.lastIndex = 0;
      return regex.test(line.text);
    });
    const before = contextCount(request.beforeLines);
    const after = contextCount(request.afterLines);
    const excerpts = matched.map((match) => {
      const first = Math.max(0, match.number - 1 - before);
      const last = Math.min(scanLines.length, match.number + after);
      const selected = scanLines.slice(first, last);
      const excerpt = selected.map((line) => line.raw).join('');
      return {
        matchLine: match.number,
        startLine: first + 1,
        endLine: last,
        sourceOffset: selected[0]?.startByte ?? match.startByte,
        sourceSelectedBytes: Buffer.byteLength(excerpt),
        excerpt,
      };
    });
    const sourceSelectedBytes = excerpts.reduce(
      (sum, item) => sum + item.sourceSelectedBytes,
      0,
    );
    const returned: typeof excerpts = [];
    for (const excerpt of excerpts.slice(0, MAX_MATCHES)) {
      if (
        Buffer.byteLength(JSON.stringify([...returned, excerpt])) >
        PAYLOAD_BYTES
      )
        break;
      returned.push(excerpt);
    }
    const returnedBytes = returned.reduce(
      (sum, item) => sum + item.sourceSelectedBytes,
      0,
    );
    return {
      metadata,
      beforeLines: before,
      afterLines: after,
      scannedBytes: scanEnd,
      unscannedBytes: bytes.length - scanEnd,
      totalMatches: matched.length,
      returnedMatches: returned.length,
      matchesRemaining: matched.length - returned.length,
      matchLimit: MAX_MATCHES,
      ...accounting(
        bytes.length,
        sourceSelectedBytes,
        returnedBytes,
        returned,
        bytes.length - scanEnd,
      ),
    };
  }

  let full: string;
  let sourceOffset: number | undefined;
  let sourceRemaining: number;
  let sourceSelectedForAccounting: number | undefined;
  if (request.mode === 'heading') {
    if (!request.heading || request.heading.length > 512)
      throw new Error('heading is required');
    let selection: ReturnType<typeof selectTextRange>;
    try {
      selection = selectTextRange(text, { heading: request.heading });
    } catch {
      throw new Error('Markdown heading not found');
    }
    full = selection.text;
    sourceOffset = Buffer.byteLength(text.slice(0, selection.start), 'utf8');
    sourceRemaining = bytes.length - Buffer.byteLength(full);
  } else if (request.mode === 'json') {
    const parsed = JSON.parse(text) as unknown;
    let selected =
      request.pointer !== undefined
        ? decodePointer(parsed, request.pointer)
        : parsed;
    if (request.field !== undefined) {
      if (
        selected === null ||
        typeof selected !== 'object' ||
        !Object.hasOwn(selected, request.field)
      )
        throw new Error(`JSON field not found: ${request.field}`);
      selected = (selected as Record<string, unknown>)[request.field];
    }
    full = typeof selected === 'string' ? selected : JSON.stringify(selected);
    sourceRemaining = 0;
    sourceSelectedForAccounting = bytes.length; // Parsing consumed the complete source.
  } else {
    throw new Error(`Unsupported retrieval mode: ${request.mode as string}`);
  }
  const selectorResultBytes = Buffer.byteLength(full);
  const returned = prefix(full);
  return {
    metadata,
    ...(sourceOffset === undefined ? {} : { sourceOffset }),
    ...accounting(
      bytes.length,
      sourceSelectedForAccounting ?? selectorResultBytes,
      returned.bytes,
      returned.text,
      sourceRemaining,
      selectorResultBytes,
    ),
  };
}

export function renderRetrievalResult(result: Record<string, unknown>): string {
  const rendered = JSON.stringify(result);
  if (Buffer.byteLength(rendered) > MAX_RESULT_BYTES)
    throw new Error('Internal result ceiling exceeded');
  return rendered;
}
