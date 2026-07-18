import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fetchAllContent } from './extract';
import { renderFetchCall, renderWebResult } from './render';
import {
  boundedPreview,
  persistenceDetails,
  persistWebResult,
} from './result-support';
import { generateId, type WebResultStore } from './storage';
import { throwIfAborted } from './utils';

const parameters = Type.Object({
  url: Type.Optional(
    Type.String({ description: 'One page URL', maxLength: 4_096 }),
  ),
  urls: Type.Optional(
    Type.Array(Type.String({ maxLength: 4_096 }), {
      description: 'Page URLs to retrieve in parallel',
      maxItems: 10,
    }),
  ),
});

function urlList(
  url: string | undefined,
  urls: string[] | undefined,
): string[] {
  const input = urls?.length ? urls : url ? [url] : [];
  return [...new Set(input.map((item) => item.trim()).filter(Boolean))];
}

export function createFetchContentTool(options: {
  pi: ExtensionAPI;
  resultStore: WebResultStore;
  operationGuard: (signal?: AbortSignal) => () => void;
}) {
  const { pi, resultStore, operationGuard } = options;
  return defineTool({
    name: 'fetch_content',
    label: 'Fetch Content',
    description:
      'Retrieve the readable content of one or more public HTTP(S) pages as Markdown. Use this for URLs supplied by the user or found in search results.',
    promptSnippet: 'Retrieve readable content from public web pages',
    parameters,
    async execute(_callId, params, signal, onUpdate, ctx) {
      const assertCurrent = operationGuard(signal);
      const urls = urlList(params.url, params.urls);
      if (urls.length === 0) throw new Error('Provide url or urls.');
      onUpdate?.({
        content: [{ type: 'text', text: `Fetching ${urls.length} URL(s)…` }],
        details: { phase: 'fetch' },
      });
      const results = await fetchAllContent(urls, signal);
      throwIfAborted(signal);
      const id = generateId();
      if (results.length === 1) {
        const result = results[0];
        if (result.error) throw new Error(result.error);
        const artifact = await persistWebResult(
          pi,
          ctx,
          resultStore,
          {
            id,
            type: 'fetch',
            timestamp: Date.now(),
            urls: results,
          },
          assertCurrent,
        );
        return {
          content: [
            {
              type: 'text',
              text: boundedPreview(
                result.content,
                id,
                'urlIndex: 0',
                artifact.artifact?.handle,
                artifact.continuationAvailable,
              ).rendered,
            },
          ],
          details: {
            responseId: id,
            title: result.title,
            totalChars: result.content.length,
            ...persistenceDetails(artifact),
          },
        };
      }
      const successful = results.filter((item) => !item.error).length;
      if (successful === 0)
        throw new Error(
          `All content fetches failed: ${results.map((item) => item.error).join('; ')}`,
        );
      const summary = results
        .map((result, index) =>
          result.error
            ? `${index}. ${result.url} — Error: ${result.error}`
            : `${index}. ${result.title || result.url} — ${result.content.length} characters`,
        )
        .join('\n');
      const renderedSummary = `${summary}\n\nResponse ID: ${id}`;
      const artifact = await persistWebResult(
        pi,
        ctx,
        resultStore,
        {
          id,
          type: 'fetch',
          timestamp: Date.now(),
          urls: results,
          summary: renderedSummary,
        },
        assertCurrent,
      );
      const initial = boundedPreview(
        renderedSummary,
        id,
        'view: "summary"',
        artifact.artifact?.handle,
        artifact.continuationAvailable,
      );
      return {
        content: [{ type: 'text', text: initial.rendered }],
        details: {
          responseId: id,
          urlCount: urls.length,
          successful,
          ...persistenceDetails(artifact),
          ...initial.details,
        },
      };
    },
    renderCall: renderFetchCall,
    renderResult: renderWebResult,
  });
}
