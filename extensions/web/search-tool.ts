import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import pLimit from 'p-limit';
import { Type } from 'typebox';
import { fetchAllContent } from './extract';
import { renderSearchCall, renderWebResult } from './render';
import {
  boundedPreview,
  persistenceDetails,
  persistWebResult,
} from './result-support';
import { search } from './search';
import {
  generateId,
  type QueryResultData,
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
});

function queryList(
  query: string | undefined,
  queries: string[] | undefined,
): string[] {
  const input = queries?.length ? queries : query ? [query] : [];
  return [...new Set(input.map((item) => item.trim()).filter(Boolean))];
}

export function createWebSearchTool(options: {
  pi: ExtensionAPI;
  resultStore: WebResultStore;
  operationGuard: (signal?: AbortSignal) => () => void;
}) {
  const { pi, resultStore, operationGuard } = options;
  return defineTool({
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the public web for current information and source links. Use query for one search or queries for several independent searches. Set includeContent when you need the readable text of result pages.',
    promptSnippet:
      'Search the public web for current information and cited sources',
    parameters,
    async execute(_callId, params, signal, onUpdate, ctx) {
      const assertCurrent = operationGuard(signal);
      const queries = queryList(params.query, params.queries);
      if (queries.length === 0) throw new Error('Provide query or queries.');
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
      if (failed === queryResults.length)
        throw new Error(
          `All web searches failed: ${queryResults.map((item) => item.error).join('; ')}`,
        );
      const summary = `${output}\n\nResponse ID: ${id}`;
      const artifact = await persistWebResult(
        pi,
        ctx,
        resultStore,
        {
          id,
          type: 'search',
          timestamp: Date.now(),
          queries: queryResults,
          summary,
        },
        assertCurrent,
      );
      const initial = boundedPreview(
        summary,
        id,
        'view: "summary"',
        artifact.continuationAvailable,
      );
      return {
        content: [{ type: 'text', text: initial.rendered }],
        details: {
          responseId: id,
          queryCount: queries.length,
          failed,
          ...persistenceDetails(artifact),
          ...initial.details,
        },
      };
    },
    renderCall: renderSearchCall,
    renderResult: renderWebResult,
  });
}
