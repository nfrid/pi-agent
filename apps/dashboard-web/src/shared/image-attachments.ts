export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_SIZE = 12 * 1024 * 1024;

export type ImageAttachment = { file: File; previewUrl: string };

export function addImageAttachments(
  existing: readonly File[],
  incoming: readonly File[],
): { accepted: File[]; error?: string } {
  const accepted: File[] = [];
  let totalSize = existing.reduce((total, file) => total + file.size, 0);
  let error: string | undefined;
  for (const file of incoming) {
    if (file.size === 0) {
      error ??= `${file.name} is empty.`;
      continue;
    }
    if (!IMAGE_TYPES.includes(file.type as (typeof IMAGE_TYPES)[number])) {
      error ??= `${file.name} is not a PNG, JPEG, or WebP image.`;
      continue;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      error ??= `${file.name} is larger than the 5 MiB image limit.`;
      continue;
    }
    if (existing.length + accepted.length >= MAX_IMAGE_ATTACHMENTS) {
      error ??= `You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`;
      continue;
    }
    if (totalSize + file.size > MAX_IMAGE_TOTAL_SIZE) {
      error ??= 'Attached images exceed the 12 MiB total limit.';
      continue;
    }
    accepted.push(file);
    totalSize += file.size;
  }
  return { accepted, ...(error ? { error } : {}) };
}
