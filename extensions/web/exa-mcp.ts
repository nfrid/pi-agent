import type { ExtractedContent } from './extract';
import type { SearchOptions, SearchResponse } from './types';
import { fetchWithRetry, readResponseTextLimited } from './utils';

const EXA_MCP_URL = 'https://mcp.exa.ai/mcp';

type McpParsedResult = { title: string; url: string; content: string };

interface ExaMcpRpcResponse {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: {
    code?: number;
    message?: string;
  };
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(60000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function callExaMcp(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchWithRetry(EXA_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    }),
    signal: requestSignal(signal),
  });

  if (!response.ok) {
    const errorText = await readResponseTextLimited(response, 64 * 1024);
    throw new Error(
      `Exa MCP error ${response.status}: ${errorText.slice(0, 300)}`,
    );
  }

  const body = await readResponseTextLimited(response, 10 * 1024 * 1024);
  const dataLines = body.split('\n').filter((line) => line.startsWith('data:'));

  let parsed: ExaMcpRpcResponse | null = null;
  for (const line of dataLines) {
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const candidate = JSON.parse(payload) as ExaMcpRpcResponse;
      if (candidate?.result || candidate?.error) {
        parsed = candidate;
        break;
      }
    } catch {}
  }

  if (!parsed) {
    try {
      const candidate = JSON.parse(body) as ExaMcpRpcResponse;
      if (candidate?.result || candidate?.error) {
        parsed = candidate;
      }
    } catch {}
  }

  if (!parsed) {
    throw new Error('Exa MCP returned an empty response');
  }

  if (parsed.error) {
    const code =
      typeof parsed.error.code === 'number' ? ` ${parsed.error.code}` : '';
    const message = parsed.error.message || 'Unknown error';
    throw new Error(`Exa MCP error${code}: ${message}`);
  }

  if (parsed.result?.isError) {
    const message = parsed.result.content
      ?.find((item) => item.type === 'text' && typeof item.text === 'string')
      ?.text?.trim();
    throw new Error(message || 'Exa MCP returned an error');
  }

  const text = parsed.result?.content?.find(
    (item) =>
      item.type === 'text' &&
      typeof item.text === 'string' &&
      item.text.trim().length > 0,
  )?.text;

  if (!text) {
    throw new Error('Exa MCP returned empty content');
  }

  return text;
}

function parseMcpResults(text: string): McpParsedResult[] | null {
  const blocks = text
    .split(/(?=^Title: )/m)
    .filter((block) => block.trim().length > 0);
  const parsed = blocks
    .map((block) => {
      const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? '';
      const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? '';
      let content = '';
      const textStart = block.indexOf('\nText: ');
      if (textStart >= 0) {
        content = block.slice(textStart + 7).trim();
      } else {
        const hlMatch = block.match(/\nHighlights:\s*\n/);
        if (hlMatch?.index != null) {
          content = block.slice(hlMatch.index + hlMatch[0].length).trim();
        }
      }
      content = content.replace(/\n---\s*$/, '').trim();
      return { title, url, content };
    })
    .filter((result) => result.url.length > 0);
  return parsed.length > 0 ? parsed : null;
}

function buildAnswerFromMcpResults(results: McpParsedResult[]): string {
  if (results.length === 0) return '';
  const parts: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const snippet = result.content.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!snippet) continue;
    const sourceTitle = result.title || `Source ${i + 1}`;
    parts.push(`${snippet}\nSource: ${sourceTitle} (${result.url})`);
  }
  return parts.join('\n\n');
}

function mapMcpInlineContent(results: McpParsedResult[]): ExtractedContent[] {
  return results
    .filter((result) => result.content.length > 0)
    .map((result) => ({
      url: result.url,
      title: result.title,
      content: result.content,
      error: null,
    }));
}

function buildMcpQuery(query: string, options: SearchOptions): string {
  const parts = [query];
  if (options.domainFilter?.length) {
    for (const d of options.domainFilter) {
      parts.push(d.startsWith('-') ? `-site:${d.slice(1)}` : `site:${d}`);
    }
  }
  if (options.recencyFilter) {
    const now = new Date();
    switch (options.recencyFilter) {
      case 'day':
        parts.push('past 24 hours');
        break;
      case 'week':
        parts.push('past week');
        break;
      case 'month':
        parts.push(
          `${now.toLocaleString('en', { month: 'long' })} ${now.getFullYear()}`,
        );
        break;
      case 'year':
        parts.push(String(now.getFullYear()));
        break;
    }
  }
  return parts.join(' ');
}

export async function searchWithExaMcp(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse | null> {
  const enrichedQuery = buildMcpQuery(query, options);
  const text = await callExaMcp(
    'web_search_exa',
    {
      query: enrichedQuery,
      numResults: options.numResults ?? 5,
      livecrawl: 'fallback',
      type: 'auto',
      contextMaxCharacters: options.includeContent ? 50000 : 3000,
    },
    options.signal,
  );
  const parsedResults = parseMcpResults(text);

  if (!parsedResults) return null;

  const response: SearchResponse = {
    answer: buildAnswerFromMcpResults(parsedResults),
    results: parsedResults.map((result, index) => ({
      title: result.title || `Source ${index + 1}`,
      url: result.url,
      snippet: '',
    })),
  };

  if (options.includeContent) {
    const inlineContent = mapMcpInlineContent(parsedResults);
    if (inlineContent.length > 0) response.inlineContent = inlineContent;
  }

  return response;
}
