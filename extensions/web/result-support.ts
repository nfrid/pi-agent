import { CACHE_FILE_MAX_BYTES, writeCacheFile } from '../shared/cache-files';
import { pageContent } from './content-retrieval';
import type { StoredSearchData, WebResultStore } from './storage';

/** Keep routine web results small; exact content remains in the in-memory/retrieval view. */
export const MAX_INLINE_CHARS = 12_000;
const CACHE_FILE_WARNING =
  'Cache file unavailable; continuation remains available in this process.';
const CAPTURE_LIMIT_WARNING =
  'Exact cache file unavailable; aggregate result exceeded the cache-file limit.';

export interface StoredPayload {
  cacheFile?: { path: string; size: number };
  warning?: string;
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
    return { warning: CAPTURE_LIMIT_WARNING };
  }

  assertCurrent();
  try {
    const cacheFile = await writeCacheFile(serialized, '.json');
    assertCurrent();
    results.store(data.id, data, cacheFile);
    return { cacheFile };
  } catch {
    assertCurrent();
    // Keep the current-process continuation even when filesystem publication fails.
    results.store(data.id, data);
    return { warning: CACHE_FILE_WARNING };
  }
}

export function persistenceDetails(payload: StoredPayload) {
  return {
    ...(payload.cacheFile ? { cacheFile: payload.cacheFile } : {}),
    ...(payload.warning ? { cacheFileWarning: payload.warning } : {}),
  };
}

export function appendCacheFileNotice(
  text: string,
  payload: StoredPayload,
): string {
  if (payload.cacheFile)
    return `${text}\n\nFull response file: ${payload.cacheFile.path} (${payload.cacheFile.size} bytes)`;
  return payload.warning ? `${text}\n\n${payload.warning}` : text;
}

function truncatedPreviewNotice(
  contentLength: number,
  responseId: string,
  selector: string,
  selectedChars: number,
  nextOffset: number | null,
  continuationAvailable = true,
): string {
  const noticeBudget = MAX_INLINE_CHARS - 512;
  if (!continuationAvailable)
    return `[Content truncated: showing ${selectedChars} of ${contentLength} characters. ${CAPTURE_LIMIT_WARNING}]`;
  const base = `[Content truncated: showing ${selectedChars} of ${contentLength} characters. Use get_search_content({ responseId: "${responseId}", ${selector}, offset: ${nextOffset} }) to continue.]`;
  if (base.length <= noticeBudget) return base;
  return `[Content truncated: showing ${selectedChars} of ${contentLength} characters. Use get_search_content to continue.]`;
}

export function boundedPreview(
  content: string,
  responseId: string,
  selector: string,
  continuationAvailable = true,
): ReturnType<typeof pageContent> & { rendered: string } {
  if (content.length <= MAX_INLINE_CHARS) {
    const page = pageContent(content, { maxChars: MAX_INLINE_CHARS });
    return { ...page, rendered: page.text };
  }

  const noticeBudget = MAX_INLINE_CHARS - 512;
  const notice = truncatedPreviewNotice(
    content.length,
    responseId,
    selector,
    Math.min(content.length, noticeBudget),
    noticeBudget,
    continuationAvailable,
  );
  const budget = Math.max(2, MAX_INLINE_CHARS - notice.length - 2);
  const page = pageContent(content, { maxChars: budget });
  const finalNotice = truncatedPreviewNotice(
    content.length,
    responseId,
    selector,
    page.details.selectedChars,
    page.details.nextOffset,
    continuationAvailable,
  );
  return { ...page, rendered: `${page.text}\n\n${finalNotice}` };
}
