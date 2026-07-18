import type { SearchResult } from './types';
import { readResponseTextLimited } from './utils';

export async function parseOpenAIResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await readResponseTextLimited(response, 10 * 1024 * 1024);
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return { output: parsed };
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : { output: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`OpenAI API returned invalid JSON: ${message}`);
    }
  }

  const outputItems: unknown[] = [];
  let completedResponse: Record<string, unknown> | null = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (parsed.type === 'response.output_item.done' && parsed.item)
        outputItems.push(parsed.item);
      if (
        (parsed.type === 'response.done' ||
          parsed.type === 'response.completed') &&
        parsed.response &&
        typeof parsed.response === 'object'
      ) {
        completedResponse = parsed.response as Record<string, unknown>;
      }
    } catch {}
  }

  if (completedResponse) {
    const output = Array.isArray(completedResponse.output)
      ? completedResponse.output
      : [];
    return output.length > 0
      ? completedResponse
      : { ...completedResponse, output: outputItems };
  }
  if (outputItems.length > 0) return { output: outputItems };
  throw new Error('OpenAI API returned no parseable response output');
}

function cleanSourceUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.get('utm_source') === 'openai')
      url.searchParams.delete('utm_source');
    return url.toString();
  } catch {
    return rawUrl.replace(/[?&]utm_source=openai$/, '');
  }
}

function extractSnippetAround(
  text: string,
  start: unknown,
  end: unknown,
): string {
  if (typeof start !== 'number' || typeof end !== 'number' || !text) return '';
  const before = Math.max(0, start - 100);
  const after = Math.min(text.length, end + 100);
  const snippet = text
    .slice(before, after)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
  return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

function addResult(
  results: SearchResult[],
  seen: Set<string>,
  url: unknown,
  title: unknown,
  snippet = '',
): void {
  if (typeof url !== 'string' || url.trim().length === 0) return;
  const cleanUrl = cleanSourceUrl(url);
  if (seen.has(cleanUrl)) return;
  seen.add(cleanUrl);
  results.push({
    title:
      typeof title === 'string' && title.trim().length > 0 ? title : cleanUrl,
    url: cleanUrl,
    snippet,
  });
}

export function extractSearchResults(
  output: unknown[],
  numResults: number | undefined,
): SearchResult[] {
  const results: SearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const item of output) {
    if (
      !item ||
      typeof item !== 'object' ||
      (item as { type?: unknown }).type !== 'message'
    )
      continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text =
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '';
      const annotations = (part as { annotations?: unknown }).annotations;
      if (!Array.isArray(annotations)) continue;
      for (const annotation of annotations) {
        if (
          !annotation ||
          typeof annotation !== 'object' ||
          (annotation as { type?: unknown }).type !== 'url_citation'
        )
          continue;
        addResult(
          results,
          seenUrls,
          (annotation as { url?: unknown }).url,
          (annotation as { title?: unknown }).title,
          extractSnippetAround(
            text,
            (annotation as { start_index?: unknown }).start_index,
            (annotation as { end_index?: unknown }).end_index,
          ),
        );
      }
    }
  }

  for (const item of output) {
    if (
      !item ||
      typeof item !== 'object' ||
      (item as { type?: unknown }).type !== 'web_search_call'
    )
      continue;
    const value = item as {
      action?: unknown;
      sources?: unknown;
      results?: unknown;
    };
    const actionSources =
      value.action && typeof value.action === 'object'
        ? (value.action as { sources?: unknown }).sources
        : undefined;
    const sourceGroups = [actionSources, value.sources, value.results];
    for (const group of sourceGroups) {
      if (!Array.isArray(group)) continue;
      for (const source of group) {
        if (!source || typeof source !== 'object') continue;
        const record = source as Record<string, unknown>;
        addResult(
          results,
          seenUrls,
          record.url ?? record.source_website_url,
          record.title ?? record.caption,
        );
      }
    }
  }

  if (
    typeof numResults === 'number' &&
    Number.isFinite(numResults) &&
    numResults > 0
  ) {
    return results.slice(0, Math.min(Math.floor(numResults), 20));
  }
  return results;
}

export function extractAnswer(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (
      !item ||
      typeof item !== 'object' ||
      (item as { type?: unknown }).type !== 'message'
    )
      continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim().length > 0) parts.push(text);
    }
  }
  return parts.join('\n').trim();
}
