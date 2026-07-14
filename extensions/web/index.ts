import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fetchAllContent } from './extract';
import {
  renderFetchCall,
  renderGetContentCall,
  renderSearchCall,
  renderWebResult,
} from './render';
import { search } from './search';
import {
  generateId,
  getResult,
  type QueryResultData,
  restoreFromSession,
  type StoredSearchData,
  storeResult,
} from './storage';
import { throwIfAborted } from './utils';

const MAX_INLINE_CHARS = 30_000;

function queryList(
  query: string | undefined,
  queries: string[] | undefined,
): string[] {
  const input = queries?.length ? queries : query ? [query] : [];
  return [...new Set(input.map((item) => item.trim()).filter(Boolean))];
}

function urlList(
  url: string | undefined,
  urls: string[] | undefined,
): string[] {
  const input = urls?.length ? urls : url ? [url] : [];
  return [...new Set(input.map((item) => item.trim()).filter(Boolean))];
}

function store(pi: ExtensionAPI, data: StoredSearchData): void {
  storeResult(data.id, data);
  pi.appendEntry('web-search-results', data);
}

function truncate(
  content: string,
  responseId: string,
  selector: string,
): string {
  if (content.length <= MAX_INLINE_CHARS) return content;
  return `${content.slice(0, MAX_INLINE_CHARS)}\n\n[Content truncated: showing ${MAX_INLINE_CHARS} of ${content.length} characters. Use get_search_content({ responseId: "${responseId}", ${selector} }) for the full text.]`;
}

const recencySchema = Type.Union(
  [
    Type.Literal('day'),
    Type.Literal('week'),
    Type.Literal('month'),
    Type.Literal('year'),
  ],
  { description: 'Prefer results published within this period' },
);

export default function web(pi: ExtensionAPI): void {
  pi.on('session_start', (_event, ctx) => restoreFromSession(ctx));
  pi.on('session_tree', (_event, ctx) => restoreFromSession(ctx));

  pi.registerTool({
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the public web for current information and source links. Use query for one search or queries for several independent searches. Set includeContent when you need the readable text of result pages.',
    promptSnippet:
      'Search the public web for current information and cited sources',
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description: 'One focused search query',
          maxLength: 2_000,
        }),
      ),
      queries: Type.Optional(
        Type.Array(Type.String({ maxLength: 2_000 }), {
          description:
            'Independent queries to run in one call; use varied angles for broader research',
          maxItems: 8,
        }),
      ),
      numResults: Type.Optional(
        Type.Integer({
          description: 'Maximum source links to return per query',
          minimum: 1,
          maximum: 20,
        }),
      ),
      recencyFilter: Type.Optional(recencySchema),
      domainFilter: Type.Optional(
        Type.Array(Type.String({ maxLength: 253 }), {
          description:
            'Hostnames to include; prefix a hostname with - to exclude it',
          maxItems: 50,
        }),
      ),
      includeContent: Type.Optional(
        Type.Boolean({
          description: 'Also fetch readable text from result URLs',
        }),
      ),
    }),
    async execute(_callId, params, signal, onUpdate, ctx) {
      const queries = queryList(params.query, params.queries);
      if (queries.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: provide query or queries.' }],
          details: { error: 'No query provided' },
          isError: true,
        };
      }
      const id = generateId();
      const queryResults: QueryResultData[] = [];
      for (let index = 0; index < queries.length; index += 1) {
        const query = queries[index];
        onUpdate?.({
          content: [
            {
              type: 'text',
              text: `Searching ${index + 1}/${queries.length}: ${query}`,
            },
          ],
          details: { phase: 'search', index, total: queries.length },
        });
        try {
          const result = await search(
            query,
            {
              numResults: params.numResults,
              recencyFilter: params.recencyFilter,
              domainFilter: params.domainFilter,
              includeContent: params.includeContent,
              signal,
            },
            ctx as ExtensionContext,
          );
          let content = result.inlineContent;
          if (params.includeContent && !content?.length) {
            content = await fetchAllContent(
              result.results.map((item) => item.url),
              signal,
            );
          }
          queryResults.push({
            query,
            answer: result.answer,
            results: result.results,
            error: null,
            provider: result.provider,
            content,
          });
        } catch (error) {
          throwIfAborted(signal);
          queryResults.push({
            query,
            answer: '',
            results: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const data: StoredSearchData = {
        id,
        type: 'search',
        timestamp: Date.now(),
        queries: queryResults,
      };
      store(pi, data);
      const output = queryResults
        .map((item) => {
          if (item.error) return `## ${item.query}\n\nError: ${item.error}`;
          const sources = item.results
            .map(
              (result, index) =>
                `${index + 1}. [${result.title}](${result.url})${result.snippet ? ` — ${result.snippet}` : ''}`,
            )
            .join('\n');
          return `## ${item.query}\n\n${item.answer}\n\n### Sources\n${sources}`;
        })
        .join('\n\n---\n\n');
      const failed = queryResults.filter((item) => item.error).length;
      return {
        content: [
          {
            type: 'text',
            text: truncate(
              `${output}\n\nResponse ID: ${id}`,
              id,
              'queryIndex: 0',
            ),
          },
        ],
        details: { responseId: id, queryCount: queries.length, failed },
        isError: failed === queries.length,
      };
    },
    renderCall: renderSearchCall,
    renderResult: renderWebResult,
  });

  pi.registerTool({
    name: 'fetch_content',
    label: 'Fetch Content',
    description:
      'Retrieve the readable content of one or more public HTTP(S) pages as Markdown. Use this for URLs supplied by the user or found in search results.',
    promptSnippet: 'Retrieve readable content from public web pages',
    parameters: Type.Object({
      url: Type.Optional(
        Type.String({ description: 'One page URL', maxLength: 4_096 }),
      ),
      urls: Type.Optional(
        Type.Array(Type.String({ maxLength: 4_096 }), {
          description: 'Page URLs to retrieve in parallel',
          maxItems: 10,
        }),
      ),
    }),
    async execute(_callId, params, signal, onUpdate) {
      const urls = urlList(params.url, params.urls);
      if (urls.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: provide url or urls.' }],
          details: { error: 'No URL provided' },
          isError: true,
        };
      }
      onUpdate?.({
        content: [{ type: 'text', text: `Fetching ${urls.length} URL(s)…` }],
        details: { phase: 'fetch' },
      });
      const results = await fetchAllContent(urls, signal);
      const id = generateId();
      store(pi, { id, type: 'fetch', timestamp: Date.now(), urls: results });
      if (results.length === 1) {
        const result = results[0];
        if (result.error) {
          return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
            details: { responseId: id, error: result.error },
            isError: true,
          };
        }
        return {
          content: [
            { type: 'text', text: truncate(result.content, id, 'urlIndex: 0') },
          ],
          details: {
            responseId: id,
            title: result.title,
            totalChars: result.content.length,
          },
        };
      }
      const successful = results.filter((item) => !item.error).length;
      const summary = results
        .map((result, index) =>
          result.error
            ? `${index}. ${result.url} — Error: ${result.error}`
            : `${index}. ${result.title || result.url} — ${result.content.length} characters`,
        )
        .join('\n');
      return {
        content: [{ type: 'text', text: `${summary}\n\nResponse ID: ${id}` }],
        details: {
          responseId: id,
          urlCount: urls.length,
          successful,
        },
        isError: successful === 0,
      };
    },
    renderCall: renderFetchCall,
    renderResult: renderWebResult,
  });

  pi.registerTool({
    name: 'get_search_content',
    label: 'Get Search Content',
    description:
      'Retrieve content saved by web_search or fetch_content. Pass the returned responseId and optionally select a query or page by index or exact value.',
    promptSnippet: 'Retrieve previously saved web search or page content',
    parameters: Type.Object({
      responseId: Type.String({ description: 'ID returned by a web tool' }),
      query: Type.Optional(
        Type.String({ description: 'Exact stored search query' }),
      ),
      queryIndex: Type.Optional(
        Type.Integer({ description: 'Zero-based query index', minimum: 0 }),
      ),
      url: Type.Optional(Type.String({ description: 'Exact stored page URL' })),
      urlIndex: Type.Optional(
        Type.Integer({ description: 'Zero-based page index', minimum: 0 }),
      ),
    }),
    async execute(_callId, params) {
      const data = getResult(params.responseId);
      if (!data) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: no stored result for ${params.responseId}.`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }
      if (data.type === 'fetch') {
        const item = params.url
          ? data.urls?.find((result) => result.url === params.url)
          : data.urls?.[params.urlIndex ?? 0];
        return {
          content: [
            {
              type: 'text',
              text: item
                ? item.error
                  ? `Error: ${item.error}`
                  : item.content
                : 'Error: URL not found in stored result.',
            },
          ],
          details: undefined,
          isError: !item || !!item.error,
        };
      }
      const query = params.query
        ? data.queries?.find((item) => item.query === params.query)
        : data.queries?.[params.queryIndex ?? 0];
      if (!query) {
        return {
          content: [
            { type: 'text', text: 'Error: query not found in stored result.' },
          ],
          details: undefined,
          isError: true,
        };
      }
      if (query.error) {
        return {
          content: [{ type: 'text', text: `Error: ${query.error}` }],
          details: undefined,
          isError: true,
        };
      }
      if (params.url !== undefined || params.urlIndex !== undefined) {
        const item = params.url
          ? query.content?.find((result) => result.url === params.url)
          : query.content?.[params.urlIndex ?? 0];
        return {
          content: [
            {
              type: 'text',
              text: item
                ? item.error
                  ? `Error: ${item.error}`
                  : item.content
                : 'Error: stored page content not found; search with includeContent: true.',
            },
          ],
          details: undefined,
          isError: !item || !!item.error,
        };
      }
      const sources = query.results
        .map((item) => `${item.title}\n${item.url}`)
        .join('\n\n');
      return {
        content: [{ type: 'text', text: `${query.answer}\n\n${sources}` }],
        details: undefined,
      };
    },
    renderCall: renderGetContentCall,
    renderResult: renderWebResult,
  });
}
