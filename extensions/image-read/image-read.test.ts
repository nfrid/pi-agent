import { mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { PhotonImage } from '@silvia-odwyer/photon-node';
import { describe, expect, it } from 'vitest';
import { cropRasterImage } from './crop.js';
import imageReadExtension from './index.js';

function gridPng(width = 4, height = 3): Buffer {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels.set([x * 30, y * 40, x + y, 255], offset);
    }
  }
  const image = new PhotonImage(pixels, width, height);
  try {
    return Buffer.from(image.get_bytes());
  } finally {
    image.free();
  }
}

function encodedGrid(format: 'jpeg' | 'webp', width = 2, height = 2): Buffer {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels.set(
      [(index * 47) & 255, (index * 83) & 255, (index * 131) & 255, 255],
      index * 4,
    );
  }
  const image = new PhotonImage(pixels, width, height);
  try {
    return Buffer.from(
      format === 'jpeg' ? image.get_bytes_jpeg(90) : image.get_bytes_webp(),
    );
  } finally {
    image.free();
  }
}

function onePixelBmp(): Buffer {
  const bytes = Buffer.alloc(58);
  bytes.write('BM');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(1, 18);
  bytes.writeInt32LE(1, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(4, 34);
  bytes.set([0, 0, 255, 0], 54);
  return bytes;
}

function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0);
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.set([0xff, 0xe1]);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), app1, payload, jpeg.subarray(2)]);
}

function noisyPng(width: number, height: number): Buffer {
  const pixels = new Uint8Array(width * height * 4);
  let state = 0x12345678;
  for (let index = 0; index < pixels.length; index += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels.set(
      [state & 255, (state >>> 8) & 255, (state >>> 16) & 255, 255],
      index,
    );
  }
  const image = new PhotonImage(pixels, width, height);
  try {
    return Buffer.from(image.get_bytes());
  } finally {
    image.free();
  }
}

function decodePng(data: string): {
  width: number;
  height: number;
  pixels: Uint8Array;
} {
  const image = PhotonImage.new_from_byteslice(Buffer.from(data, 'base64'));
  try {
    return {
      width: image.get_width(),
      height: image.get_height(),
      pixels: image.get_raw_pixels(),
    };
  } finally {
    image.free();
  }
}

function registeredReadTool() {
  let tool: Parameters<ExtensionAPI['registerTool']>[0] | undefined;
  imageReadExtension({
    registerTool(definition: Parameters<ExtensionAPI['registerTool']>[0]) {
      tool = definition;
    },
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error('read tool was not registered');
  return tool;
}

describe('image read crops', () => {
  it('returns the exact requested source pixels and dimensions', async () => {
    const result = await cropRasterImage(gridPng(), {
      x: 1,
      y: 1,
      width: 2,
      height: 2,
    });
    expect(result).toMatchObject({
      mimeType: 'image/png',
      sourceWidth: 4,
      sourceHeight: 3,
      width: 2,
      height: 2,
    });

    const decoded = decodePng(result.data);
    expect(decoded).toMatchObject({ width: 2, height: 2 });
    expect([...decoded.pixels]).toEqual([
      30, 40, 2, 255, 60, 40, 3, 255, 30, 80, 3, 255, 60, 80, 4, 255,
    ]);
  });

  it('accepts a crop ending exactly at the source edge', async () => {
    expect(
      await cropRasterImage(gridPng(), { x: 2, y: 1, width: 2, height: 2 }),
    ).toMatchObject({
      sourceWidth: 4,
      sourceHeight: 3,
      width: 2,
      height: 2,
    });
  });

  it.each([
    ['PNG', gridPng(1, 1)],
    ['JPEG', encodedGrid('jpeg')],
    [
      'GIF',
      Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
    ],
    ['WebP', encodedGrid('webp')],
    ['BMP', onePixelBmp()],
  ])('crops supported %s input', async (_format, bytes) => {
    const result = await cropRasterImage(bytes, {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(result).toMatchObject({
      mimeType: 'image/png',
      sourceWidth: expect.any(Number),
      sourceHeight: expect.any(Number),
      width: 1,
      height: 1,
    });
  });

  it('uses EXIF-oriented source coordinates', async () => {
    const oriented = withExifOrientation(encodedGrid('jpeg', 2, 3), 6);
    await expect(
      cropRasterImage(oriented, { x: 2, y: 0, width: 1, height: 2 }),
    ).resolves.toMatchObject({
      sourceWidth: 3,
      sourceHeight: 2,
      width: 1,
      height: 2,
    });
  });

  it.each([
    [{ x: -1, y: 0, width: 1, height: 1 }, 'non-negative'],
    [{ x: 0, y: 0, width: 0, height: 1 }, 'positive'],
    [{ x: 3, y: 0, width: 2, height: 1 }, 'exceeds source bounds'],
    [{ x: 0, y: 0, width: 2001, height: 1 }, 'output limit'],
    [{ x: 0.5, y: 0, width: 1, height: 1 }, 'safe integer'],
  ] as const)('rejects invalid crop %#', async (crop, message) => {
    await expect(cropRasterImage(gridPng(), crop)).rejects.toThrow(message);
  });

  it('rejects declared source dimensions above the decode limit', async () => {
    const oversizedHeader = gridPng(1, 1);
    oversizedHeader.writeUInt32BE(6000, 16);
    oversizedHeader.writeUInt32BE(5000, 20);
    await expect(
      cropRasterImage(oversizedHeader, { x: 0, y: 0, width: 1, height: 1 }),
    ).rejects.toThrow('25,000,000-pixel decode limit');
  });

  it('rejects encoded attachments above the base64 response limit', async () => {
    const noisy = noisyPng(1200, 1200);
    await expect(
      cropRasterImage(noisy, { x: 0, y: 0, width: 1200, height: 1200 }),
    ).rejects.toThrow('4.5MB attachment limit');
  });

  it('rejects malformed WebP chunk lengths before decoding', async () => {
    const webp = encodedGrid('webp');
    const junk = Buffer.alloc(8);
    junk.write('JUNK');
    junk.writeInt32LE(-1, 4);
    const malformed = Buffer.concat([webp, junk]);
    malformed.writeUInt32LE(malformed.length - 8, 4);
    await expect(
      cropRasterImage(malformed, { x: 0, y: 0, width: 1, height: 1 }),
    ).rejects.toThrow('Malformed WebP chunk length');
  });

  it('terminates decoder work at the finite worker deadline', async () => {
    await expect(
      cropRasterImage(
        noisyPng(100, 100),
        { x: 0, y: 0, width: 100, height: 100 },
        undefined,
        0,
      ),
    ).rejects.toThrow('0ms processing limit');
  });

  it('terminates crop work when aborted', async () => {
    const controller = new AbortController();
    const pending = cropRasterImage(
      noisyPng(800, 800),
      { x: 0, y: 0, width: 800, height: 800 },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow('Operation aborted');
  });

  it('rejects non-image input before decoding', async () => {
    await expect(
      cropRasterImage(Buffer.from('not an image'), {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      }),
    ).rejects.toThrow('readable raster images');
  });

  it('exposes strict crop schema bounds', () => {
    const tool = registeredReadTool();
    expect(tool.name).toBe('read');
    expect(tool.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        crop: {
          properties: {
            width: { maximum: 2000, minimum: 1 },
            height: { maximum: 2000, minimum: 1 },
          },
        },
      },
    });
  });

  it('preserves built-in whole-image reads when crop is omitted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'image-read-'));
    await writeFile(join(cwd, 'grid.png'), gridPng());
    const tool = registeredReadTool();
    const result = await tool.execute(
      'read-image',
      { path: 'grid.png' },
      undefined,
      undefined,
      { cwd } as never,
    );
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Read image file [image/png]'),
    });
    expect(result.content[1]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
    });
  });

  it('preserves built-in text reads when crop is omitted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'image-read-'));
    await writeFile(join(cwd, 'sample.txt'), 'one\ntwo\nthree\n');
    const tool = registeredReadTool();
    const result = await tool.execute(
      'read-text',
      { path: 'sample.txt', offset: 2, limit: 1 },
      undefined,
      undefined,
      { cwd } as never,
    );
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'two\n\n[2 more lines in file. Use offset=3 to continue.]',
      },
    ]);
  });

  it('rejects oversized source files before reading them', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'image-read-'));
    const file = await open(join(cwd, 'oversized.png'), 'w');
    await file.truncate(50 * 1024 * 1024 + 1);
    await file.close();
    const tool = registeredReadTool();

    await expect(
      tool.execute(
        'read-crop',
        { path: 'oversized.png', crop: { x: 0, y: 0, width: 1, height: 1 } },
        undefined,
        undefined,
        { cwd } as never,
      ),
    ).rejects.toThrow('50MB crop input limit');
  });

  it('supports built-in file URL path semantics for crops', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'image-read-'));
    const path = join(cwd, 'grid with spaces.png');
    await writeFile(path, gridPng());
    const tool = registeredReadTool();
    const result = await tool.execute(
      'read-crop',
      {
        path: pathToFileURL(path).href,
        crop: { x: 0, y: 0, width: 1, height: 1 },
      },
      undefined,
      undefined,
      { cwd } as never,
    );
    expect(result.details).toMatchObject({
      returnedWidth: 1,
      returnedHeight: 1,
    });
  });

  it('returns crop metadata from the registered tool', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'image-read-'));
    await writeFile(join(cwd, 'grid.png'), gridPng());
    const tool = registeredReadTool();
    const result = await tool.execute(
      'read-crop',
      { path: 'grid.png', crop: { x: 1, y: 0, width: 2, height: 2 } },
      undefined,
      undefined,
      { cwd } as never,
    );
    expect(result.details).toEqual({
      crop: { x: 1, y: 0, width: 2, height: 2 },
      sourceWidth: 4,
      sourceHeight: 3,
      returnedWidth: 2,
      returnedHeight: 2,
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Source: 4x3; returned: 2x2'),
    });
    expect(result.content[1]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
    });
  });
});
