import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_COUNT = 4;

export type DashboardImage = {
  type: 'image';
  path: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
};

function validDimensions(width: number, height: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width * height <= 40_000_000
  );
}

function validPng(data: Buffer): boolean {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (data.length < 45 || !data.subarray(0, 8).equals(signature)) return false;
  let offset = 8;
  let header = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) return false;
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (!header) {
      if (type !== 'IHDR' || length !== 13) return false;
      if (
        !validDimensions(
          data.readUInt32BE(offset + 8),
          data.readUInt32BE(offset + 12),
        )
      )
        return false;
      header = true;
    }
    if (type === 'IEND') return length === 0 && end === data.length;
    offset = end;
  }
  return false;
}

function validJpeg(data: Buffer): boolean {
  if (
    data.length < 12 ||
    data[0] !== 0xff ||
    data[1] !== 0xd8 ||
    data[data.length - 2] !== 0xff ||
    data[data.length - 1] !== 0xd9
  )
    return false;
  let offset = 2;
  let dimensions = false;
  while (offset + 4 <= data.length - 2) {
    if (data[offset] !== 0xff) return false;
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset];
    offset += 1;
    if (marker === 0xda) return dimensions;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length - 2) return false;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length - 2) return false;
    const frame =
      marker !== undefined &&
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf));
    if (frame) {
      if (length < 7) return false;
      dimensions = validDimensions(
        data.readUInt16BE(offset + 5),
        data.readUInt16BE(offset + 3),
      );
      if (!dimensions) return false;
    }
    offset += length;
  }
  return false;
}

function validWebp(data: Buffer): boolean {
  if (
    data.length < 30 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.readUInt32LE(4) + 8 !== data.length ||
    data.toString('ascii', 8, 12) !== 'WEBP'
  )
    return false;
  const chunk = data.toString('ascii', 12, 16);
  const length = data.readUInt32LE(16);
  if (20 + length > data.length) return false;
  if (chunk === 'VP8X' && length >= 10)
    return validDimensions(
      1 + data.readUIntLE(24, 3),
      1 + data.readUIntLE(27, 3),
    );
  if (chunk === 'VP8L' && length >= 5 && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return validDimensions(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
  }
  if (
    chunk === 'VP8 ' &&
    length >= 10 &&
    data[23] === 0x9d &&
    data[24] === 0x01 &&
    data[25] === 0x2a
  )
    return validDimensions(
      data.readUInt16LE(26) & 0x3fff,
      data.readUInt16LE(28) & 0x3fff,
    );
  return false;
}

export function imageMediaType(
  data: Buffer,
): DashboardImage['mediaType'] | undefined {
  if (validPng(data)) return 'image/png';
  if (validJpeg(data)) return 'image/jpeg';
  if (validWebp(data)) return 'image/webp';
  return undefined;
}

/** Owns bounded image persistence and cleanup; callers never supply paths. */
export class UploadService {
  private readonly directory: string;
  private readonly active = new Set<string>();

  constructor(stateDir: string) {
    this.directory = path.join(stateDir, 'uploads');
  }

  async start(): Promise<void> {
    await fs.rm(this.directory, { recursive: true, force: true });
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  async save(buffers: readonly Buffer[]): Promise<DashboardImage[]> {
    if (buffers.length === 0 || buffers.length > MAX_IMAGE_COUNT)
      throw new Error('Attach between one and four images.');
    let total = 0;
    const created: DashboardImage[] = [];
    try {
      for (const data of buffers) {
        if (data.length === 0 || data.length > MAX_IMAGE_BYTES)
          throw new Error('Each image must be between 1 byte and 5 MiB.');
        total += data.length;
        if (total > MAX_IMAGE_TOTAL_BYTES)
          throw new Error('Image attachments exceed the 12 MiB total limit.');
        const mediaType = imageMediaType(data);
        if (!mediaType)
          throw new Error('Only PNG, JPEG, and WebP are allowed.');
        const file = path.join(
          this.directory,
          `${Date.now()}-${randomBytes(16).toString('hex')}`,
        );
        await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' });
        this.active.add(file);
        created.push({ type: 'image', path: file, mediaType });
      }
      return created;
    } catch (error) {
      await this.cleanup(created.map((image) => image.path));
      throw error;
    }
  }

  async cleanup(files: readonly string[]): Promise<void> {
    await Promise.all(
      files.map(async (file) => {
        this.active.delete(file);
        await fs.rm(file, { force: true });
      }),
    );
  }

  async close(): Promise<void> {
    await this.cleanup([...this.active]);
    await fs.rm(this.directory, { recursive: true, force: true });
  }
}
