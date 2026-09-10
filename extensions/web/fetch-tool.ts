import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fetchAllContent } from './extract';
import { renderFetchCall, renderWebResult } from './render';
import {
  appendCacheFileNotice,
  boundedPreview,
  compactManifest,
  persistenceDetails,
  persistWebResult,
  stripContentIdLines,
} from './result-support';
import { generateId, type StoredContent, type WebResultStore } from './storage';
import { throwIfAborted } from './utils';

const parameters = Type.Object({
  urls: Type.Array(Type.String({ maxLength: 4_096 }), {
    description: 'Page URLs to retrieve in parallel',
    minItems: 1,
    maxItems: 10,
  }),
});

function urlList(urls: string[]): string[] {
  return [...new Set(urls.map((item) => item.trim()).filter(Boolean))];
}

export function createFetchContentTool(options: {
  resultStore: WebResultStore;
  operationGuard: (signal?: AbortSignal) => () => void;
}) {
  const { resultStore, operationGuard } = options;
  return defineTool({
    name: 'fetch_content',
    label: 'Fetch Content',
    description:
      'Retrieve the readable content of one or more public HTTP(S) pages as Markdown. Use this for URLs supplied by the user or found in search results.',
    promptSnippet: 'Retrieve readable content from public web pages',
    parameters,
    async execute(_callId, params, signal, onUpdate) {
      const assertCurrent = operationGuard(signal);
      const urls = urlList(params.urls);
      if (urls.length === 0) throw new Error('Provide at least one URL.');
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
        const contentId = `${id}:page:0`;
        const manifest = `Content ID: ${contentId} — ${result.title || result.url} — ${result.url}`;
        const payload = await persistWebResult(
          resultStore,
          {
            id,
            type: 'fetch',
            timestamp: Date.now(),
            urls: results,
            contents: [{ id: contentId, text: result.content }],
          },
          assertCurrent,
        );
        return {
          content: [
            {
              type: 'text',
              text: appendCacheFileNotice(
                boundedPreview(
                  result.content,
                  contentId,
                  payload.continuationAvailable,
                  payload.continuationAvailable
                    ? compactManifest(manifest)
                    : undefined,
                ).rendered,
                payload,
              ),
            },
          ],
          details: {
            contentId,
            title: result.title,
            totalChars: result.content.length,
            ...persistenceDetails(payload),
          },
        };
      }
      const successful = results.filter((item) => !item.error).length;
      if (successful === 0)
        throw new Error(
          `All content fetches failed: ${results.map((item) => item.error).join('; ')}`,
        );
      const summaryId = `${id}:summary`;
      const pageEntries = results.flatMap((result, index) =>
        result.error
          ? []
          : [
              {
                id: `${id}:page:${index}`,
                title: result.title || result.url,
                url: result.url,
              },
            ],
      );
      const summary = results
        .map((result, index) =>
          result.error
            ? `${index}. ${result.url} — Error: ${result.error}`
            : `${index}. ${result.title || result.url} — ${result.content.length} characters\n   Content ID: ${id}:page:${index}`,
        )
        .join('\n');
      const manifest = [
        'Content ID manifest:',
        `- Summary: ${summaryId}`,
        ...pageEntries.map(
          (page) => `- Page: ${page.id} — ${page.title} — ${page.url}`,
        ),
      ].join('\n');
      const renderedSummary = `${summary}\n\n${manifest}`;
      const pageIds = pageEntries.map((page) => page.id);
      const contents: StoredContent[] = [
        { id: summaryId, text: renderedSummary },
        ...results.flatMap((result, index) =>
          result.error
            ? []
            : [{ id: `${id}:page:${index}`, text: result.content }],
        ),
      ];
      const payload = await persistWebResult(
        resultStore,
        {
          id,
          type: 'fetch',
          timestamp: Date.now(),
          urls: results,
          summary: renderedSummary,
          contents,
        },
        assertCurrent,
      );
      const previewContent = payload.continuationAvailable
        ? renderedSummary
        : stripContentIdLines(summary);
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
          contentIds: {
            summary: summaryId,
            pages: pageIds.filter(
              (pageId): pageId is string => pageId !== null,
            ),
          },
          urlCount: urls.length,
          successful,
          ...persistenceDetails(payload),
          ...initial.details,
        },
      };
    },
    renderCall: renderFetchCall,
    renderResult: renderWebResult,
  });
}
