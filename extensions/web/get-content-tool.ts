import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  DEFAULT_CONTENT_CHARS,
  MAX_CONTENT_CHARS,
  pageContent,
} from './content-retrieval';
import { renderGetContentCall, renderWebResult } from './render';
import { persistenceDetails, truncatedPreviewNotice } from './result-support';
import type { WebResultStore } from './storage';
import { throwIfAborted } from './utils';

const parameters = Type.Object({
  contentId: Type.String({
    description: 'Content ID returned by web_search or fetch_content',
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
      'Read a bounded slice of saved web content by ID. IDs expire on session shutdown or extension reload. Partial slices include the exact offset for continuing.',
    promptSnippet: 'Retrieve previously saved web search or page content',
    parameters,
    async execute(_callId, params, signal) {
      throwIfAborted(signal);
      const stored = resultStore.getContent(params.contentId);
      if (!stored)
        throw new Error(`Content ID not found: ${params.contentId}.`);
      const respond = (sourceText: string) => {
        const page = pageContent(sourceText, {
          offset: params.offset,
          maxChars: params.maxChars,
        });
        const text =
          page.details.nextOffset === null
            ? page.text
            : `${page.text}\n\n${truncatedPreviewNotice(
                stored.text.length,
                params.contentId,
                page.details.selectedChars,
                page.details.nextOffset,
                true,
              )}`;
        return {
          content: [{ type: 'text' as const, text }],
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
