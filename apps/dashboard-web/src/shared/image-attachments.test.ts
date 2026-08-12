import { describe, expect, it } from 'vitest';
import { addImageAttachments, MAX_IMAGE_TOTAL_SIZE } from './image-attachments';

describe('image attachment validation', () => {
  const image = (name: string, type: string, size: number) =>
    new File([new Uint8Array(size)], name, { type });

  it('accepts valid images and reports the first invalid file', () => {
    const result = addImageAttachments(
      [],
      [image('one.png', 'image/png', 4), image('bad.gif', 'image/gif', 1)],
    );
    expect(result.accepted).toEqual([expect.any(File)]);
    expect(result.error).toContain('not a PNG');
  });

  it('enforces the total image size across existing and incoming files', () => {
    const existing = image(
      'existing.webp',
      'image/webp',
      MAX_IMAGE_TOTAL_SIZE - 1,
    );
    const result = addImageAttachments(
      [existing],
      [image('new.jpg', 'image/jpeg', 2)],
    );
    expect(result.accepted).toEqual([]);
    expect(result.error).toContain('12 MiB total');
  });
});
