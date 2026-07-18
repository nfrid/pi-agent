import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  DEFAULT_CONTENT_CHARS,
  MAX_CONTENT_CHARS,
  pageContent,
} from './content-retrieval';
import { renderGetContentCall, renderWebResult } from './render';
import { artifactDetails } from './result-support';
import type { WebResultStore } from './storage';
import { throwIfAborted } from './utils';

const parameters = Type.Object({
  responseId: Type.String({
    description: 'ID returned by a web tool',
    maxLength: 128,
  }),
  view: Type.Optional(
    Type.Literal('summary', {
      description: 'Retrieve the exact rendered aggregate/summary view',
    }),
  ),
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
  offset: Type.Optional(
    Type.Integer({
      description: 'UTF-16 offset within selected text',
      minimum: 0,
    }),
  ),
  maxChars: Type.Optional(
    Type.Integer({
      description: `Maximum characters to return (default ${DEFAULT_CONTENT_CHARS})`,
      minimum: 2,
      maximum: MAX_CONTENT_CHARS,
    }),
  ),
  heading: Type.Optional(
    Type.String({
      description: 'Exact Markdown heading text',
      maxLength: 500,
    }),
  ),
  literal: Type.Optional(
    Type.String({
      description: 'Select the first line containing this exact text',
      maxLength: 2_000,
    }),
  ),
});

export function createGetSearchContentTool(resultStore: WebResultStore) {
  return defineTool({
    name: 'get_search_content',
    label: 'Get Search Content',
    description:
      'Retrieve a bounded, exact slice of content saved by web_search or fetch_content. Use view: "summary" to continue an aggregate search or multi-URL summary; or narrow page content with a heading or literal selector.',
    promptSnippet: 'Retrieve previously saved web search or page content',
    parameters,
    async execute(_callId, params, signal) {
      throwIfAborted(signal);
      const artifact = resultStore.artifact(params.responseId);
      const respond = (text: string) => {
        const page = pageContent(text, {
          offset: params.offset,
          maxChars: params.maxChars,
          heading: params.heading,
          literal: params.literal,
        });
        return {
          content: [{ type: 'text' as const, text: page.text }],
          details: {
            responseId: params.responseId,
            ...(artifact ? { artifact: artifactDetails(artifact) } : {}),
            ...page.details,
          },
        };
      };
      const data = resultStore.get(params.responseId);
      if (!data) throw new Error(`No stored result for ${params.responseId}.`);
      if (params.view === 'summary') {
        if (!data.summary)
          throw new Error('No stored summary view for this result.');
        return respond(data.summary);
      }
      if (data.type === 'fetch') {
        const item = params.url
          ? data.urls?.find((result) => result.url === params.url)
          : data.urls?.[params.urlIndex ?? 0];
        if (!item) throw new Error('URL not found in stored result.');
        if (item.error) throw new Error(item.error);
        return respond(item.content);
      }
      const query = params.query
        ? data.queries?.find((item) => item.query === params.query)
        : data.queries?.[params.queryIndex ?? 0];
      if (!query) throw new Error('Query not found in stored result.');
      if (query.error) throw new Error(query.error);
      if (params.url !== undefined || params.urlIndex !== undefined) {
        const item = params.url
          ? query.content?.find((result) => result.url === params.url)
          : query.content?.[params.urlIndex ?? 0];
        if (!item)
          throw new Error(
            'Stored page content not found; search with includeContent: true.',
          );
        if (item.error) throw new Error(item.error);
        return respond(item.content);
      }
      const sources = query.results
        .map((item) => `${item.title}\n${item.url}`)
        .join('\n\n');
      return respond(`${query.answer}\n\n${sources}`);
    },
    renderCall: renderGetContentCall,
    renderResult: renderWebResult,
  });
}
