import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  type ArtifactMetadata,
  type ArtifactReference,
  artifactProducer,
  MAX_ARTIFACT_BYTES,
} from '../artifacts';
import { pageContent } from './content-retrieval';
import {
  type StoredSearchData,
  WEB_REFERENCE_TYPE,
  type WebResultStore,
} from './storage';

const MAX_INLINE_CHARS = 30_000;
const ARTIFACT_WARNING =
  'Exact artifact unavailable; continuation is limited to this session.';
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
  if (serializedBytes > MAX_ARTIFACT_BYTES)
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
    return {
      warning: ARTIFACT_WARNING,
      continuationAvailable: false,
    };
  }
}

export function artifactDetails(
  artifact: ArtifactMetadata,
): ArtifactReference & {
  size: number;
  producer: ArtifactMetadata['producer'];
  contentClass: ArtifactMetadata['contentClass'];
  creationSource: string;
  itemCount?: number;
} {
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
  continuationAvailable = true,
): string {
  const noticeBudget = MAX_INLINE_CHARS - 512;
  if (!continuationAvailable)
    return `[Content truncated: showing ${selectedChars} of ${contentLength} characters. ${CAPTURE_LIMIT_WARNING}]`;
  const base = `[Content truncated: showing ${selectedChars} of ${contentLength} characters. Use get_search_content({ responseId: "${responseId}", ${selector}, offset: ${nextOffset} }) to continue.]`;
  if (base.length <= noticeBudget) return base;
  return `[Content truncated: showing ${selectedChars} of ${contentLength} characters. Use get_search_content to continue.]`;
}

export function boundedPreview(
  content: string,
  responseId: string,
  selector: string,
  continuationAvailable = true,
): ReturnType<typeof pageContent> & { rendered: string } {
  if (content.length <= MAX_INLINE_CHARS) {
    const page = pageContent(content, { maxChars: MAX_INLINE_CHARS });
    return { ...page, rendered: page.text };
  }

  const noticeBudget = MAX_INLINE_CHARS - 512;
  const notice = truncatedPreviewNotice(
    content.length,
    responseId,
    selector,
    Math.min(content.length, noticeBudget),
    noticeBudget,
    continuationAvailable,
  );
  const budget = Math.max(2, MAX_INLINE_CHARS - notice.length - 2);
  const page = pageContent(content, { maxChars: budget });
  const finalNotice = truncatedPreviewNotice(
    content.length,
    responseId,
    selector,
    page.details.selectedChars,
    page.details.nextOffset,
    continuationAvailable,
  );
  return { ...page, rendered: `${page.text}\n\n${finalNotice}` };
}
