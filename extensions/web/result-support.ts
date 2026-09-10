import { CACHE_FILE_MAX_BYTES, writeCacheFile } from '../shared/cache-files';
import { pageContent } from './content-retrieval';
import type { StoredSearchData, WebResultStore } from './storage';

/** Keep routine web results small; exact content remains in the in-memory/retrieval view. */
export const MAX_INLINE_CHARS = 12_000;
const MAX_VISIBLE_MANIFEST_LINE = 240;
const CACHE_FILE_WARNING =
  'Cache file unavailable; continuation remains available in this process.';
const CAPTURE_LIMIT_WARNING =
  'Exact cache file unavailable; aggregate result exceeded the cache-file limit.';

export interface StoredPayload {
  cacheFile?: { path: string; size: number };
  warning?: string;
  continuationAvailable: boolean;
}

export async function persistWebResult(
  results: WebResultStore,
  data: StoredSearchData,
  assertCurrent: () => void,
): Promise<StoredPayload> {
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized) > CACHE_FILE_MAX_BYTES) {
    assertCurrent();
    results.store(data.id, data);
    return {
      warning: CAPTURE_LIMIT_WARNING,
      continuationAvailable: results.get(data.id) !== null,
    };
  }

  assertCurrent();
  try {
    const cacheFile = await writeCacheFile(serialized, '.json');
    assertCurrent();
    results.store(data.id, data, cacheFile);
    return { cacheFile, continuationAvailable: results.get(data.id) !== null };
  } catch {
    assertCurrent();
    // Keep the current-process continuation even when filesystem publication fails.
    results.store(data.id, data);
    return {
      warning: CACHE_FILE_WARNING,
      continuationAvailable: results.get(data.id) !== null,
    };
  }
}

export function persistenceDetails(
  payload: Pick<StoredPayload, 'cacheFile' | 'warning'>,
) {
  return {
    ...(payload.cacheFile ? { cacheFile: payload.cacheFile } : {}),
    ...(payload.warning ? { cacheFileWarning: payload.warning } : {}),
  };
}

export function compactManifest(manifest: string): string {
  const lines: string[] = [];
  let length = 0;
  for (const rawLine of manifest.split('\n')) {
    const line =
      rawLine.length > MAX_VISIBLE_MANIFEST_LINE
        ? `${rawLine.slice(0, MAX_VISIBLE_MANIFEST_LINE - 1)}…`
        : rawLine;
    if (length + line.length + 1 > 3_800) {
      lines.push('… More content IDs are available in the stored summary.');
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n');
}

export function stripContentIdLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.includes('Content ID:'))
    .filter((line) => !line.startsWith('Content ID manifest:'))
    .filter((line) => !/^\s*- (?:Summary|Query|Page): /.test(line))
    .join('\n');
}

export function appendCacheFileNotice(
  text: string,
  payload: StoredPayload,
): string {
  if (payload.cacheFile)
    return `${text}\n\nFull response file: ${payload.cacheFile.path} (${payload.cacheFile.size} bytes)`;
  return payload.warning ? `${text}\n\n${payload.warning}` : text;
}

export function truncatedPreviewNotice(
  contentLength: number,
  contentId: string,
  selectedChars: number,
  nextOffset: number | null,
  continuationAvailable: boolean,
): string {
  const noticeBudget = MAX_INLINE_CHARS - 512;
  if (!continuationAvailable)
    return `[Content truncated: showing ${selectedChars} of ${contentLength} characters. ${CAPTURE_LIMIT_WARNING}]`;
  const base = `[Content truncated: showing ${selectedChars} of ${contentLength} characters. Use get_search_content({ contentId: "${contentId}", offset: ${nextOffset} }) to continue.]`;
  if (base.length <= noticeBudget) return base;
  return `[Content truncated: showing ${selectedChars} of ${contentLength} characters. Use get_search_content to continue.]`;
}

export function boundedPreview(
  content: string,
  contentId: string,
  continuationAvailable: boolean,
  visibleManifest?: string,
): ReturnType<typeof pageContent> & { rendered: string } {
  const manifest =
    continuationAvailable && visibleManifest
      ? compactManifest(visibleManifest)
      : undefined;
  const appendManifest = (rendered: string) =>
    manifest && !rendered.includes(manifest)
      ? `${rendered}\n\n${manifest}`
      : rendered;
  const inlineBudget = MAX_INLINE_CHARS - (manifest ? manifest.length + 2 : 0);
  if (content.length <= inlineBudget) {
    const page = pageContent(content, { maxChars: inlineBudget });
    return { ...page, rendered: appendManifest(page.text) };
  }

  const noticeBudget = inlineBudget - 512;
  const notice = truncatedPreviewNotice(
    content.length,
    contentId,
    Math.min(content.length, noticeBudget),
    noticeBudget,
    continuationAvailable,
  );
  const budget = Math.max(2, inlineBudget - notice.length - 2);
  const page = pageContent(content, { maxChars: budget });
  const finalNotice = truncatedPreviewNotice(
    content.length,
    contentId,
    page.details.selectedChars,
    page.details.nextOffset,
    continuationAvailable,
  );
  return {
    ...page,
    rendered: appendManifest(`${page.text}\n\n${finalNotice}`),
  };
}
