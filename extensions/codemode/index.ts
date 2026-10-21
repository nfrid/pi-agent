import { createHash } from 'node:crypto';
import {
  createCodemodeExtension,
  type ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { defineExtension } from '../shared/runtime/extension';

const MAX_NESTED_READS = 256;
const MAX_IMAGES_PER_READ = 4;
const MAX_PARENT_IMAGES = 4;

type ImageHash = string;
type ReadImageHashes = Map<string, ImageHash[]>;

export function imageHash(value: unknown): ImageHash | undefined {
  if (!isRecord(value) || value.type !== 'image') return undefined;
  if (typeof value.mimeType !== 'string' || typeof value.data !== 'string')
    return undefined;
  return createHash('sha256')
    .update(value.mimeType)
    .update('\0')
    .update(value.data)
    .digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Match only image blocks retained in the final codemode output. */
export function nestedReadImageMappings(
  reads: ReadonlyMap<string, readonly ImageHash[]>,
  content: unknown,
): { toolCallId: string; imageIndexes: number[] }[] {
  if (!Array.isArray(content)) return [];
  const ordinalsByHash = new Map<ImageHash, number[]>();
  let ordinal = 0;
  for (const block of content) {
    if (isRecord(block) && block.type === 'image') {
      const hash = imageHash(block);
      if (hash && ordinal < MAX_PARENT_IMAGES) {
        const indexes = ordinalsByHash.get(hash) ?? [];
        indexes.push(ordinal);
        ordinalsByHash.set(hash, indexes);
      }
      ordinal++;
    }
  }
  const mappings: { toolCallId: string; imageIndexes: number[] }[] = [];
  for (const [toolCallId, hashes] of reads) {
    const imageIndexes = [
      ...new Set(
        hashes
          .slice(0, MAX_IMAGES_PER_READ)
          .flatMap((hash) => ordinalsByHash.get(hash) ?? []),
      ),
    ].sort((a, b) => a - b);
    if (imageIndexes.length)
      mappings.push({ toolCallId, imageIndexes: imageIndexes.slice(0, 4) });
  }
  return mappings;
}

export default defineExtension('codemode', (pi) => {
  const activeReads = new Map<string, ReadImageHashes>();
  pi.on('tool_result', (event: ToolResultEvent) => {
    const reads = event.parentToolCallId
      ? activeReads.get(event.parentToolCallId)
      : undefined;
    if (!reads || event.toolName !== 'read' || reads.size >= MAX_NESTED_READS)
      return;
    const hashes = event.content
      .map(imageHash)
      .filter((hash): hash is ImageHash => hash !== undefined)
      .slice(0, MAX_IMAGES_PER_READ);
    reads.set(event.toolCallId, hashes);
  });

  createCodemodeExtension({ models: false })({
    ...pi,
    registerTool(tool) {
      // Shared instructions own selection policy; drop codemode's generic batching hint.
      const definition = { ...tool };
      delete definition.promptGuidelines;
      if (definition.name === 'codemode') {
        const execute = definition.execute;
        definition.execute = async (
          toolCallId,
          params,
          signal,
          onUpdate,
          ctx,
        ) => {
          const reads: ReadImageHashes = new Map();
          activeReads.set(toolCallId, reads);
          try {
            const result = await execute(
              toolCallId,
              params,
              signal,
              onUpdate,
              ctx,
            );
            const nestedReadImages = nestedReadImageMappings(
              reads,
              result.content,
            );
            if (!nestedReadImages.length) return result;
            return {
              ...result,
              details: {
                ...(isRecord(result.details) ? result.details : {}),
                nestedReadImages,
              },
            } as typeof result;
          } finally {
            activeReads.delete(toolCallId);
          }
        };
      }
      pi.registerTool(definition);
    },
  });
});
