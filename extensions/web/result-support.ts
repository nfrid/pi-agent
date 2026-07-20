import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  type ArtifactMetadata,
  artifactProducer,
  MAX_ARTIFACT_BYTES,
} from '../artifacts';
import { pageContent } from './content-retrieval';
import {
  type StoredSearchData,
  WEB_FALLBACK_TYPE,
  WEB_REFERENCE_TYPE,
  type WebResultStore,
} from './storage';

const MAX_INLINE_CHARS = 30_000;
const ARTIFACT_WARNING =
  'Exact artifact unavailable; retained an in-session fallback.';
const CAPTURE_LIMIT_WARNING =
  'Exact continuation unavailable; aggregate result exceeded the persistence limit.';

export interface StoredPayload {
  artifact?: ArtifactMetadata;
  warning?: string;
  continuationAvailable: boolean;
}

export async function persistWebResult(
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

export function artifactDetails(artifact: ArtifactMetadata) {
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

export function persistenceDetails(payload: StoredPayload) {
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
  return `[Content truncated: showing ${selectedChars} of ${contentLength} characters. Use get_search_content({ responseId: "${responseId}", ${selector}, offset: ${nextOffset} }) to continue.${artifactHandle ? ` Exact payload artifact (artifact_retrieve): ${artifactHandle}.` : ''}]`;
}

export function boundedPreview(
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
