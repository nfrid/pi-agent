import { existsSync, readFileSync } from 'node:fs';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import pLimit from 'p-limit';
import TurndownService from 'turndown';
import { extractRSCContent } from './rsc-extract';
import {
  fetchRemoteUrl,
  type Lookup,
  validateRemoteUrl,
} from './ssrf-protection';
import {
  fetchWithRetry,
  getWebSearchConfigPath,
  readResponseTextLimited,
  throwIfAborted,
} from './utils';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MIN_USEFUL_CONTENT = 300;
const fetchLimit = pLimit(3);
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

export interface ExtractedContent {
  url: string;
  title: string;
  content: string;
  error: string | null;
}

export interface ExtractOptions {
  timeoutMs?: number;
  lookup?: Lookup;
}

export function loadSsrfAllowRanges(): string[] {
  const path = getWebSearchConfigPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      ssrf?: { allowRanges?: unknown };
    };
    const value = parsed.ssrf?.allowRanges;
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      value.some((entry) => typeof entry !== 'string')
    ) {
      throw new Error(
        `ssrf.allowRanges in ${path} must be an array of CIDR strings`,
      );
    }
    return value.map((entry) => (entry as string).trim()).filter(Boolean);
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function titleFromText(text: string, url: string): string {
  const heading = text
    .match(/^#{1,2}\s+(.+)/m)?.[1]
    ?.replace(/\*+/g, '')
    .trim();
  return heading || new URL(url).pathname.split('/').pop() || url;
}

function looksDynamic(html: string): boolean {
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? '';
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length < 500 && (html.match(/<script/gi)?.length ?? 0) > 3;
}

async function extractWithJina(
  url: string,
  signal: AbortSignal | undefined,
  lookup: Lookup | undefined,
): Promise<ExtractedContent | null> {
  try {
    await validateRemoteUrl(url, {
      allowRanges: loadSsrfAllowRanges(),
      lookup,
    });
    const response = await fetchWithRetry(`https://r.jina.ai/${url}`, {
      headers: { Accept: 'text/markdown', 'X-No-Cache': 'true' },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)])
        : AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const text = await readResponseTextLimited(response, MAX_RESPONSE_BYTES);
    const marker = 'Markdown Content:';
    const markerIndex = text.indexOf(marker);
    const content =
      markerIndex >= 0
        ? text.slice(markerIndex + marker.length).trim()
        : text.trim();
    if (
      content.length < 100 ||
      /^(Loading|Please enable JavaScript)/i.test(content)
    ) {
      return null;
    }
    return { url, title: titleFromText(content, url), content, error: null };
  } catch {
    throwIfAborted(signal);
    return null;
  }
}

async function extractViaHttp(
  url: string,
  signal: AbortSignal | undefined,
  options: ExtractOptions,
): Promise<ExtractedContent> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchRemoteUrl(
      url,
      {
        headers: {
          Accept:
            'text/html,application/xhtml+xml,text/plain,application/json,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (compatible; Pi web extension)',
        },
        signal: combinedSignal,
      },
      { allowRanges: loadSsrfAllowRanges(), lookup: options.lookup },
    );
    if (!response.ok) {
      return {
        url,
        title: '',
        content: '',
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      return {
        url,
        title: '',
        content: '',
        error: 'Response too large (limit: 5MB)',
      };
    }
    const contentType =
      response.headers.get('content-type')?.toLowerCase() ?? '';
    if (
      /^(image|audio|video)\//.test(contentType) ||
      contentType.includes('application/pdf')
    ) {
      return {
        url,
        title: '',
        content: '',
        error: `Unsupported content type: ${contentType.split(';')[0]}`,
      };
    }
    const text = await readResponseTextLimited(response, MAX_RESPONSE_BYTES);
    const isHtml =
      contentType.includes('html') ||
      /^\s*<!doctype html|^\s*<html/i.test(text);
    if (!isHtml) {
      return {
        url,
        title: titleFromText(text, url),
        content: text,
        error: null,
      };
    }

    const { document } = parseHTML(text);
    const article = new Readability(document as unknown as Document).parse();
    if (article) {
      const content = turndown.turndown(article.content ?? '');
      if (content.length >= MIN_USEFUL_CONTENT) {
        return {
          url,
          title: article.title || titleFromText(content, url),
          content,
          error: null,
        };
      }
    }
    const rsc = extractRSCContent(text);
    if (rsc)
      return { url, title: rsc.title, content: rsc.content, error: null };
    return {
      url,
      title: article?.title ?? '',
      content: article ? turndown.turndown(article.content ?? '') : '',
      error: looksDynamic(text)
        ? 'Page appears to be JavaScript-rendered'
        : 'Could not extract useful readable content',
    };
  } catch (error) {
    throwIfAborted(signal);
    return { url, title: '', content: '', error: errorMessage(error) };
  }
}

export async function extractContent(
  url: string,
  signal?: AbortSignal,
  options: ExtractOptions = {},
): Promise<ExtractedContent> {
  throwIfAborted(signal);
  const result = await extractViaHttp(url, signal, options);
  if (
    !result.error ||
    result.error.startsWith('Unsupported content type') ||
    result.error.startsWith('Response too large')
  ) {
    return result;
  }
  throwIfAborted(signal);
  return (await extractWithJina(url, signal, options.lookup)) ?? result;
}

export async function fetchAllContent(
  urls: string[],
  signal?: AbortSignal,
  options: ExtractOptions = {},
): Promise<ExtractedContent[]> {
  return Promise.all(
    urls.map((url) => fetchLimit(() => extractContent(url, signal, options))),
  );
}
