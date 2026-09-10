import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  DEFAULT_CONTENT_CHARS,
  MAX_CONTENT_CHARS,
  pageContent,
} from './content-retrieval';
import { renderGetContentCall, renderWebResult } from './render';
import { persistenceDetails } from './result-support';
import type { WebResultStore } from './storage';
import { throwIfAborted } from './utils';

const parameters = Type.Object({
  contentId: Type.String({
    description:
      'Globally unique content ID returned by web_search or fetch_content',
    maxLength: 256,
  }),
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
});

export function createGetSearchContentTool(resultStore: WebResultStore) {
  return defineTool({
    name: 'get_search_content',
    label: 'Get Search Content',
    description:
      'Retrieve a bounded, exact slice of content saved by web_search or fetch_content using one returned content ID and an optional UTF-16 offset.',
    promptSnippet: 'Retrieve previously saved web search or page content',
    parameters,
    async execute(_callId, params, signal) {
      throwIfAborted(signal);
      const stored = resultStore.getContent(params.contentId);
      if (!stored)
        throw new Error(`Content ID not found: ${params.contentId}.`);
      const respond = (text: string) => {
        const page = pageContent(text, {
          offset: params.offset,
          maxChars: params.maxChars,
        });
        return {
          content: [{ type: 'text' as const, text: page.text }],
          details: {
            contentId: params.contentId,
            ...persistenceDetails(
              stored.cacheFile ? { cacheFile: stored.cacheFile } : {},
            ),
            ...page.details,
          },
        };
      };
      return respond(stored.text);
    },
    renderCall: renderGetContentCall,
    renderResult: renderWebResult,
  });
}
