import {
  defineTool,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import pLimit from 'p-limit';
import { Type } from 'typebox';
import { fetchAllContent } from './extract';
import { renderSearchCall, renderWebResult } from './render';
import {
  appendCacheFileNotice,
  boundedPreview,
  compactManifest,
  persistenceDetails,
  persistWebResult,
  stripContentIdLines,
} from './result-support';
import { search } from './search';
import {
  generateId,
  type QueryResultData,
  type StoredContent,
  type WebResultStore,
} from './storage';
import { throwIfAborted } from './utils';

const recencySchema = Type.Union(
  [
    Type.Literal('day'),
    Type.Literal('week'),
    Type.Literal('month'),
    Type.Literal('year'),
  ],
  { description: 'Prefer results published within this period' },
);

const parameters = Type.Object({
  queries: Type.Array(Type.String({ maxLength: 2_000 }), {
    description:
      'Independent queries to run in one call; use varied angles for broader research',
    minItems: 1,
    maxItems: 8,
  }),
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
});

function queryList(queries: string[]): string[] {
  return [...new Set(queries.map((item) => item.trim()).filter(Boolean))];
}

export function createWebSearchTool(options: {
  resultStore: WebResultStore;
  operationGuard: (signal?: AbortSignal) => () => void;
}) {
  const { resultStore, operationGuard } = options;
  return defineTool({
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the public web for current information and source links. Provide one or more independent queries. Set includeContent when you need the readable text of result pages.',
    promptSnippet:
      'Search the public web for current information and cited sources',
    parameters,
    async execute(_callId, params, signal, onUpdate, ctx) {
      const assertCurrent = operationGuard(signal);
      const queries = queryList(params.queries);
      if (queries.length === 0) throw new Error('Provide at least one query.');
      const id = generateId();
      const queryResults = new Array<QueryResultData>(queries.length);
      const limit = pLimit(3);
      let completed = 0;
      await Promise.all(
        queries.map((query, index) =>
          limit(async () => {
            onUpdate?.({
              content: [
                {
                  type: 'text',
                  text: `Searching ${index + 1}/${queries.length}: ${query}`,
                },
              ],
              details: {
                phase: 'search',
                index,
                completed,
                total: queries.length,
              },
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
              queryResults[index] = {
                query,
                answer: result.answer,
                results: result.results,
                error: null,
                provider: result.provider,
                content,
              };
            } catch (error) {
              throwIfAborted(signal);
              queryResults[index] = {
                query,
                answer: '',
                results: [],
                error: error instanceof Error ? error.message : String(error),
              };
            } finally {
              completed += 1;
              onUpdate?.({
                content: [
                  {
                    type: 'text',
                    text: `Completed ${completed}/${queries.length} searches`,
                  },
                ],
                details: {
                  phase: 'search',
                  index,
                  completed,
                  total: queries.length,
                },
              });
            }
          }),
        ),
      );
      throwIfAborted(signal);
      const summaryId = `${id}:summary`;
      const queryViews = queryResults.map((item, index) => {
        const contentId = `${id}:query:${index}`;
        if (item.error)
          return {
            contentId,
            text: `## Query: ${item.query}\n\nError: ${item.error}`,
            pages: [],
          };
        const sources = item.results
          .map(
            (result, resultIndex) =>
              `${resultIndex + 1}. [${result.title}](${result.url})${result.snippet ? ` — ${result.snippet}` : ''}`,
          )
          .join('\n');
        const pages = (item.content ?? []).flatMap((page, pageIndex) =>
          page.error
            ? []
            : [
                {
                  id: `${id}:query:${index}:page:${pageIndex}`,
                  title: page.title || page.url,
                  url: page.url,
                },
              ],
        );
        const readablePages = pages.length
          ? `\n\n### Readable pages\n${pages
              .map(
                (page) =>
                  `- ${page.title} — ${page.url} — Content ID: ${page.id}`,
              )
              .join('\n')}`
          : '';
        return {
          contentId,
          text: `## Query: ${item.query}\nContent ID: ${contentId}\n\n${item.answer}\n\n### Sources\n${sources}${readablePages}`,
          pages,
        };
      });
      const manifest = [
        'Content ID manifest:',
        `- Summary: ${summaryId}`,
        ...queryViews.flatMap((view, index) => [
          `- Query ${index}: ${view.contentId} — ${queryResults[index]?.query ?? ''}`,
          ...view.pages.map(
            (page) => `  - Page: ${page.id} — ${page.title} — ${page.url}`,
          ),
        ]),
      ].join('\n');
      const output = queryViews.map((view) => view.text).join('\n\n---\n\n');
      const failed = queryResults.filter((item) => item.error).length;
      if (failed === queryResults.length)
        throw new Error(
          `All web searches failed: ${queryResults.map((item) => item.error).join('; ')}`,
        );
      const summary = `${output}\n\n${manifest}`;
      const contents: StoredContent[] = [
        { id: summaryId, text: summary },
        ...queryViews.map((view) => ({ id: view.contentId, text: view.text })),
        ...queryResults.flatMap((item, queryIndex) =>
          (item.content ?? []).flatMap((page, pageIndex) =>
            page.error
              ? []
              : [
                  {
                    id: `${id}:query:${queryIndex}:page:${pageIndex}`,
                    text: page.content,
                  },
                ],
          ),
        ),
      ];
      const payload = await persistWebResult(
        resultStore,
        {
          id,
          type: 'search',
          timestamp: Date.now(),
          queries: queryResults,
          summary,
          contents,
        },
        assertCurrent,
      );
      const previewContent = payload.continuationAvailable
        ? summary
        : stripContentIdLines(output);
      const initial = boundedPreview(
        previewContent,
        summaryId,
        payload.continuationAvailable,
        payload.continuationAvailable ? compactManifest(manifest) : undefined,
      );
      return {
        content: [
          {
            type: 'text',
            text: appendCacheFileNotice(initial.rendered, payload),
          },
        ],
        details: {
          queryCount: queries.length,
          failed,
          contentIds: {
            summary: summaryId,
            queries: queryViews.map((view) => ({
              id: view.contentId,
              pages: view.pages.map((page) => page.id),
            })),
          },
          ...persistenceDetails(payload),
          ...initial.details,
        },
      };
    },
    renderCall: renderSearchCall,
    renderResult: renderWebResult,
  });
}
