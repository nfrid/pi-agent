import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { imageSize } from 'image-size';

export interface ImageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CroppedImage {
  data: string;
  mimeType: 'image/png';
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
}

export const IMAGE_CROP_LIMITS = {
  maxSourceBytes: 50 * 1024 * 1024,
  maxSourcePixels: 25_000_000,
  maxCropPixels: 4_000_000,
  maxCropDimension: 2_000,
  maxEncodedBytes: 4_500_000,
} as const;

function validateCrop(cropRegion: ImageCrop): void {
  for (const [name, value] of Object.entries(cropRegion)) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Image crop ${name} must be a safe integer.`);
    }
  }
  if (cropRegion.x < 0 || cropRegion.y < 0) {
    throw new Error('Image crop x and y must be non-negative.');
  }
  if (cropRegion.width <= 0 || cropRegion.height <= 0) {
    throw new Error('Image crop width and height must be positive.');
  }
  if (
    cropRegion.width > IMAGE_CROP_LIMITS.maxCropDimension ||
    cropRegion.height > IMAGE_CROP_LIMITS.maxCropDimension ||
    cropRegion.width * cropRegion.height > IMAGE_CROP_LIMITS.maxCropPixels
  ) {
    throw new Error(
      `Image crop exceeds the ${IMAGE_CROP_LIMITS.maxCropDimension}x${IMAGE_CROP_LIMITS.maxCropDimension} / ${IMAGE_CROP_LIMITS.maxCropPixels.toLocaleString('en-US')}-pixel output limit.`,
    );
  }
}

function validateWebpContainer(bytes: Uint8Array): void {
  const isWebp =
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP';
  if (!isWebp) return;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) {
    throw new Error('Malformed WebP container length.');
  }
  let offset = 12;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength)
      throw new Error('Malformed WebP chunk header.');
    const size = view.getUint32(offset + 4, true);
    const next = offset + 8 + size + (size % 2);
    if (
      !Number.isSafeInteger(next) ||
      next <= offset ||
      next > bytes.byteLength
    ) {
      throw new Error('Malformed WebP chunk length.');
    }
    offset = next;
  }
}

function preflightSource(bytes: Uint8Array): void {
  if (bytes.byteLength > IMAGE_CROP_LIMITS.maxSourceBytes) {
    throw new Error('Image source exceeds the 50MB crop input limit.');
  }

  validateWebpContainer(bytes);
  let dimensions: ReturnType<typeof imageSize>;
  try {
    dimensions = imageSize(bytes);
  } catch {
    throw new Error(
      'Crop is only supported for readable raster images (PNG, JPEG, GIF, WebP, or BMP).',
    );
  }
  const width = dimensions.width;
  const height = dimensions.height;
  if (!width || !height || width * height > IMAGE_CROP_LIMITS.maxSourcePixels) {
    throw new Error(
      `Image source exceeds the ${IMAGE_CROP_LIMITS.maxSourcePixels.toLocaleString('en-US')}-pixel decode limit.`,
    );
  }
}

function workerError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('Image crop worker failed.');
}

export async function cropRasterImage(
  bytes: Uint8Array,
  cropRegion: ImageCrop,
  signal?: AbortSignal,
  workerTimeoutMs = 15_000,
): Promise<CroppedImage> {
  validateCrop(cropRegion);
  preflightSource(bytes);
  signal?.throwIfAborted();

  const transferable = new Uint8Array(bytes);
  const worker = new Worker(join(__dirname, 'crop-worker.mjs'), {
    workerData: {
      bytes: transferable.buffer,
      crop: cropRegion,
      maxEncodedBytes: IMAGE_CROP_LIMITS.maxEncodedBytes,
    },
    transferList: [transferable.buffer],
  });

  try {
    return await new Promise<CroppedImage>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              `Image crop exceeded the ${workerTimeoutMs}ms processing limit.`,
            ),
          ),
        );
        void worker.terminate();
      }, workerTimeoutMs);
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = (): void => {
        finish(() => reject(new Error('Operation aborted')));
        void worker.terminate();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.once(
        'message',
        (message: { result?: CroppedImage; error?: string }) => {
          finish(() => {
            if (message.error) reject(new Error(message.error));
            else if (message.result) resolve(message.result);
            else reject(new Error('Invalid image crop worker response.'));
          });
        },
      );
      worker.once('error', (error) => finish(() => reject(workerError(error))));
      worker.once('exit', (code) => {
        if (code !== 0)
          finish(() =>
            reject(new Error(`Image crop worker exited with code ${code}.`)),
          );
      });
    });
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}
