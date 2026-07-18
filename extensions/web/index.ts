import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import pLimit from 'p-limit';
import { Type } from 'typebox';
import {
  type ArtifactMetadata,
  artifactProducer,
  MAX_ARTIFACT_BYTES,
} from '../artifacts';
import {
  DEFAULT_CONTENT_CHARS,
  MAX_CONTENT_CHARS,
  pageContent,
} from './content-retrieval';
import { fetchAllContent } from './extract';
import {
  renderFetchCall,
  renderGetContentCall,
  renderSearchCall,
  renderWebResult,
} from './render';
import { search } from './search';
import {
  createWebResultStore,
  generateId,
  type QueryResultData,
  type StoredSearchData,
  WEB_FALLBACK_TYPE,
  WEB_REFERENCE_TYPE,
  type WebResultStore,
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

interface StoredPayload {
  artifact?: ArtifactMetadata;
  warning?: string;
  continuationAvailable: boolean;
}

const ARTIFACT_WARNING =
  'Exact artifact unavailable; retained an in-session fallback.';
const CAPTURE_LIMIT_WARNING =
  'Exact continuation unavailable; aggregate result exceeded the persistence limit.';

async function store(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  results: WebResultStore,
  data: StoredSearchData,
  assertCurrent: () => void,
): Promise<StoredPayload> {
  const serialized = JSON.stringify(data);
  const serializedBytes = Buffer.byteLength(serialized);
  const fallbackBytes =
    Buffer.byteLength('{"version":1,"data":') + serializedBytes + 1;
  if (
    serializedBytes > MAX_ARTIFACT_BYTES ||
    fallbackBytes > MAX_ARTIFACT_BYTES
  )
    return {
      warning: CAPTURE_LIMIT_WARNING,
      continuationAvailable: false,
    };

  assertCurrent();
  results.store(data.id, data);
  try {
    const artifact = await artifactProducer.put(
      pi,
      ctx,
      {
        bytes: serialized,
        producer: 'web',
        contentClass: 'json',
        mediaType: 'application/json',
        creationSource: `web.${data.type}`,
        itemCount: Object.keys(data).length,
      },
      undefined,
      assertCurrent,
      (published) => {
        assertCurrent();
        pi.appendEntry(WEB_REFERENCE_TYPE, {
          version: 1,
          responseId: data.id,
          resultType: data.type,
          artifact: published,
        });
      },
    );
    try {
      assertCurrent();
      results.store(data.id, data, artifact);
    } catch {
      // Publication is already durable and linearized before the lifecycle
      // boundary; do not repopulate the new branch's in-memory index.
      results.delete(data.id);
    }
    return { artifact, continuationAvailable: true };
  } catch {
    // Do not expose artifact paths, policy details, or raw errors to the model.
    try {
      assertCurrent();
    } catch (error) {
      results.delete(data.id);
      throw error;
    }
    try {
      pi.appendEntry(WEB_FALLBACK_TYPE, { version: 1, data });
      return { warning: ARTIFACT_WARNING, continuationAvailable: true };
    } catch {
      results.delete(data.id);
      return {
        warning: CAPTURE_LIMIT_WARNING,
        continuationAvailable: false,
      };
    }
  }
}

function artifactDetails(artifact: ArtifactMetadata) {
  return {
    handle: artifact.handle,
    sha256: artifact.sha256,
    size: artifact.size,
    producer: artifact.producer,
    contentClass: artifact.contentClass,
    creationSource: artifact.creationSource,
    itemCount: artifact.itemCount,
  };
}

function persistenceDetails(payload: StoredPayload) {
  return {
    ...(payload.artifact
      ? { artifact: artifactDetails(payload.artifact) }
      : {}),
    ...(payload.warning ? { artifactWarning: payload.warning } : {}),
    ...(!payload.continuationAvailable ? { continuationAvailable: false } : {}),
  };
}

function truncatedPreviewNotice(
  contentLength: number,
  responseId: string,
  selector: string,
  selectedChars: number,
  nextOffset: number | null,
  artifactHandle?: string,
  continuationAvailable = true,
): string {
  if (!continuationAvailable)
    return `[Content truncated: showing ${selectedChars} of ${contentLength} characters. ${CAPTURE_LIMIT_WARNING}]`;
  return `[Content truncated: showing ${selectedChars} of ${contentLength} characters. Use get_search_content({ responseId: "${responseId}", ${selector}, offset: ${nextOffset} }) to continue.${artifactHandle ? ` Exact payload artifact: ${artifactHandle}.` : ''}]`;
}

function boundedPreview(
  content: string,
  responseId: string,
  selector: string,
  artifactHandle?: string,
  continuationAvailable = true,
): ReturnType<typeof pageContent> & { rendered: string } {
  if (content.length <= MAX_INLINE_CHARS) {
    const page = pageContent(content, { maxChars: MAX_INLINE_CHARS });
    return { ...page, rendered: page.text };
  }

  let budget = MAX_INLINE_CHARS - 512;
  let page = pageContent(content, { maxChars: budget });
  let notice = '';
  for (let iteration = 0; iteration < 3; iteration++) {
    notice = truncatedPreviewNotice(
      content.length,
      responseId,
      selector,
      page.details.selectedChars,
      page.details.nextOffset,
      artifactHandle,
      continuationAvailable,
    );
    budget = Math.max(2, MAX_INLINE_CHARS - notice.length - 2);
    page = pageContent(content, { maxChars: budget });
  }
  notice = truncatedPreviewNotice(
    content.length,
    responseId,
    selector,
    page.details.selectedChars,
    page.details.nextOffset,
    artifactHandle,
    continuationAvailable,
  );
  return { ...page, rendered: `${page.text}\n\n${notice}` };
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

const registered = new WeakSet<object>();

export default function web(pi: ExtensionAPI): void {
  if (registered.has(pi)) return;
  registered.add(pi);
  const resultStore = createWebResultStore();
  let lifecycleGeneration = 0;
  const reset = (ctx: ExtensionContext) => {
    lifecycleGeneration++;
    resultStore.restore(ctx);
  };
  pi.on('session_start', (_event, ctx) => reset(ctx));
  pi.on('session_tree', (_event, ctx) => reset(ctx));
  pi.on('session_shutdown', () => {
    lifecycleGeneration++;
    resultStore.clear();
  });
  const operationGuard = (signal?: AbortSignal) => {
    const generation = lifecycleGeneration;
    return () => {
      throwIfAborted(signal);
      if (generation !== lifecycleGeneration)
        throw new Error('Web operation crossed a session lifecycle boundary.');
    };
  };

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
      const artifact = await store(
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
        artifact.artifact?.handle,
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
        const artifact = await store(
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
      const artifact = await store(
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

  pi.registerTool({
    name: 'get_search_content',
    label: 'Get Search Content',
    description:
      'Retrieve a bounded, exact slice of content saved by web_search or fetch_content. Use view: "summary" to continue an aggregate search or multi-URL summary; or narrow page content with a heading or literal selector.',
    promptSnippet: 'Retrieve previously saved web search or page content',
    parameters: Type.Object({
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
    }),
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
