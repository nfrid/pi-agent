import {
  IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_TOTAL_BYTES,
} from '@pi-dashboard/protocol/pi-runtime-protocol';

export const NATIVE_IMAGE_TYPES = IMAGE_TYPES;
export const MAX_ATTACHMENTS = MAX_ATTACHMENT_COUNT;
export const MAX_ATTACHMENT_SIZE = MAX_ATTACHMENT_BYTES;
export const MAX_TOTAL_ATTACHMENT_SIZE = MAX_ATTACHMENT_TOTAL_BYTES;

export type FileAttachment = { id: string; file: File; previewUrl?: string };

export function isNativeImage(file: File): boolean {
  return NATIVE_IMAGE_TYPES.includes(
    file.type as (typeof NATIVE_IMAGE_TYPES)[number],
  );
}

export function nativeImageCount(
  attachments: readonly FileAttachment[],
): number {
  return attachments.filter((attachment) => isNativeImage(attachment.file))
    .length;
}

export function hasNativeImages(
  attachments: readonly FileAttachment[],
): boolean {
  return nativeImageCount(attachments) > 0;
}

export function addFileAttachments(
  existing: readonly File[],
  incoming: readonly File[],
): { accepted: File[]; error?: string } {
  const accepted: File[] = [];
  let totalSize = existing.reduce((total, file) => total + file.size, 0);
  let error: string | undefined;
  for (const file of incoming) {
    if (isNativeImage(file) && file.size === 0) {
      error ??= `${file.name} is empty.`;
      continue;
    }
    if (file.size > MAX_ATTACHMENT_SIZE) {
      error ??= `${file.name} is larger than the 5 MiB file limit.`;
      continue;
    }
    if (existing.length + accepted.length >= MAX_ATTACHMENTS) {
      error ??= `You can attach up to ${MAX_ATTACHMENTS} files.`;
      continue;
    }
    if (totalSize + file.size > MAX_TOTAL_ATTACHMENT_SIZE) {
      error ??= 'Attachments exceed the 12 MiB total limit.';
      continue;
    }
    accepted.push(file);
    totalSize += file.size;
  }
  return { accepted, ...(error ? { error } : {}) };
}

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}
