import { describe, expect, it, vi } from 'vitest';

vi.mock('@pi-dashboard/protocol/pi-runtime-protocol', () => ({
  IMAGE_TYPES: ['image/png', 'image/jpeg', 'image/webp'],
  MAX_ATTACHMENT_COUNT: 4,
  MAX_ATTACHMENT_BYTES: 5 * 1024 * 1024,
  MAX_ATTACHMENT_TOTAL_BYTES: 12 * 1024 * 1024,
}));

import {
  addFileAttachments,
  formatAttachmentSize,
  hasNativeImages,
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_SIZE,
  nativeImageCount,
} from './file-attachments';

describe('file attachment validation', () => {
  const file = (name: string, type: string, size: number) =>
    new File([new Uint8Array(size)], name, { type });

  it('accepts arbitrary files, including empty generic files, and native images', () => {
    const image = file('one.png', 'image/png', 4);
    const empty = file('empty.md', 'text/markdown', 0);
    const result = addFileAttachments([], [empty, image]);
    expect(result).toEqual({ accepted: [empty, image] });
    expect(
      hasNativeImages(
        result.accepted.map((attachment) => ({ id: '', file: attachment })),
      ),
    ).toBe(true);
  });

  it('classifies only supported image MIME types as native images', () => {
    const supported = file('image.png', 'image/png', 1);
    const svg = file('drawing.svg', 'image/svg+xml', 1);
    const gif = file('animation.gif', 'image/gif', 1);
    const attachments = [supported, svg, gif].map((file, index) => ({
      id: String(index),
      file,
    }));
    expect(nativeImageCount(attachments)).toBe(1);
    expect(hasNativeImages(attachments)).toBe(true);
  });

  it('formats binary file sizes with KiB and MiB units', () => {
    expect(formatAttachmentSize(1536)).toBe('1.5 KiB');
    expect(formatAttachmentSize(1.5 * 1024 * 1024)).toBe('1.5 MiB');
  });

  it('rejects empty native images and files above the per-file limit', () => {
    expect(
      addFileAttachments([], [file('empty.png', 'image/png', 0)]).error,
    ).toContain('empty');
    expect(
      addFileAttachments(
        [],
        [file('large.md', 'text/markdown', 5 * 1024 * 1024 + 1)],
      ).error,
    ).toContain('5 MiB');
  });

  it('enforces count and total size across all selected files', () => {
    const existing = Array.from({ length: MAX_ATTACHMENTS }, (_, index) =>
      file(`${index}.json`, 'application/json', 1),
    );
    expect(
      addFileAttachments(existing, [file('fifth.bin', '', 1)]).error,
    ).toContain('up to 4 files');

    const almostFull = file(
      'large.json',
      'application/json',
      MAX_TOTAL_ATTACHMENT_SIZE - 1,
    );
    expect(
      addFileAttachments([almostFull], [file('extra.txt', 'text/plain', 2)])
        .error,
    ).toContain('12 MiB total');
  });
});
