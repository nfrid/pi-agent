import type { ExtractedContent } from './extract';
import type { SearchOptions, SearchResponse } from './types';
import { fetchWithRetry, readResponseTextLimited } from './utils';

const EXA_ANSWER_URL = 'https://api.exa.ai/answer';
const EXA_SEARCH_URL = 'https://api.exa.ai/search';

interface ExaAnswerResponse {
  answer?: string;
  citations?: Array<{
    url?: string;
    title?: string;
    text?: string;
    publishedDate?: string;
  }>;
}

interface ExaSearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    publishedDate?: string;
    author?: string;
    text?: string;
    highlights?: unknown;
    highlightScores?: number[];
  }>;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(60000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function recencyToStartDate(filter: string): string {
  const now = new Date();
  const offsets: Record<string, number> = {
    day: 1,
    week: 7,
    month: 30,
    year: 365,
  };
  const days = offsets[filter] ?? 0;
  return new Date(now.getTime() - days * 86400000).toISOString();
}

function mapDomainFilter(domainFilter: string[] | undefined): {
  includeDomains?: string[];
  excludeDomains?: string[];
} {
  if (!domainFilter?.length) return {};
  const includeDomains = domainFilter
    .filter((d) => !d.startsWith('-') && d.trim().length > 0)
    .map((d) => d.trim());
  const excludeDomains = domainFilter
    .filter((d) => d.startsWith('-'))
    .map((d) => d.slice(1).trim())
    .filter(Boolean);
  return {
    ...(includeDomains.length ? { includeDomains } : {}),
    ...(excludeDomains.length ? { excludeDomains } : {}),
  };
}

function normalizeHighlights(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string =>
      typeof item === 'string' && item.trim().length > 0,
  );
}

function buildAnswerFromSearchResults(
  results: ExaSearchResponse['results'],
): string {
  if (!results?.length) return '';
  const parts: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    if (!item?.url) continue;
    const highlights = normalizeHighlights(item.highlights);
    const content =
      highlights.length > 0
        ? highlights.join(' ')
        : typeof item.text === 'string'
          ? item.text.trim().slice(0, 1000)
          : '';
    if (!content) continue;
    const sourceTitle = item.title || `Source ${i + 1}`;
    parts.push(`${content}\nSource: ${sourceTitle} (${item.url})`);
  }
  return parts.join('\n\n');
}

function mapResults(
  results: ExaSearchResponse['results'] | ExaAnswerResponse['citations'],
): SearchResponse['results'] {
  if (!Array.isArray(results)) return [];
  const mapped: SearchResponse['results'] = [];
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    if (!item?.url) continue;
    mapped.push({
      title: item.title || `Source ${i + 1}`,
      url: item.url,
      snippet: '',
    });
  }
  return mapped;
}

function mapInlineContent(
  results: ExaSearchResponse['results'],
): ExtractedContent[] {
  if (!results?.length) return [];
  return results
    .filter(
      (
        r,
      ): r is NonNullable<ExaSearchResponse['results']>[number] & {
        url: string;
        text: string;
      } => !!r?.url && typeof r.text === 'string' && r.text.length > 0,
    )
    .map((r) => ({
      url: r.url,
      title: r.title || '',
      content: r.text,
      error: null,
    }));
}

export async function searchWithExaHttp(
  apiKey: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const useSearch =
    options.includeContent ||
    !!options.recencyFilter ||
    !!options.domainFilter?.length ||
    !!(options.numResults && options.numResults !== 5);
  if (!useSearch) {
    const response = await fetchWithRetry(EXA_ANSWER_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        text: true,
      }),
      signal: requestSignal(options.signal),
    });

    if (!response.ok) {
      const errorText = await readResponseTextLimited(response, 64 * 1024);
      throw new Error(
        `Exa API error ${response.status}: ${errorText.slice(0, 300)}`,
      );
    }

    const data = JSON.parse(
      await readResponseTextLimited(response, 10 * 1024 * 1024),
    ) as ExaAnswerResponse;
    return {
      answer: data.answer || '',
      results: mapResults(data.citations),
    };
  }

  const startDate = options.recencyFilter
    ? recencyToStartDate(options.recencyFilter)
    : null;
  const domainFilters = mapDomainFilter(options.domainFilter);
  const response = await fetchWithRetry(EXA_SEARCH_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: options.numResults ?? 5,
      ...domainFilters,
      ...(startDate ? { startPublishedDate: startDate } : {}),
      contents: {
        text: options.includeContent ? true : { maxCharacters: 3000 },
        highlights: true,
      },
    }),
    signal: requestSignal(options.signal),
  });

  if (!response.ok) {
    const errorText = await readResponseTextLimited(response, 64 * 1024);
    throw new Error(
      `Exa API error ${response.status}: ${errorText.slice(0, 300)}`,
    );
  }

  const data = JSON.parse(
    await readResponseTextLimited(response, 10 * 1024 * 1024),
  ) as ExaSearchResponse;

  const mapped: SearchResponse = {
    answer: buildAnswerFromSearchResults(data.results),
    results: mapResults(data.results),
  };
  if (options.includeContent) {
    const inlineContent = mapInlineContent(data.results);
    if (inlineContent.length > 0) mapped.inlineContent = inlineContent;
  }
  return mapped;
}
