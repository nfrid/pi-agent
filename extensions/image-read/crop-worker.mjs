import { parentPort, workerData } from 'node:worker_threads';
import * as photon from '@silvia-odwyer/photon-node';

function hasExifHeader(bytes, offset) {
  return (
    bytes[offset] === 0x45 &&
    bytes[offset + 1] === 0x78 &&
    bytes[offset + 2] === 0x69 &&
    bytes[offset + 3] === 0x66 &&
    bytes[offset + 4] === 0 &&
    bytes[offset + 5] === 0
  );
}

function readOrientationFromTiff(bytes, start) {
  if (start + 8 > bytes.length) return 1;
  const littleEndian = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
  const read16 = (position) =>
    littleEndian
      ? bytes[position] | (bytes[position + 1] << 8)
      : (bytes[position] << 8) | bytes[position + 1];
  const read32 = (position) =>
    littleEndian
      ? (bytes[position] |
          (bytes[position + 1] << 8) |
          (bytes[position + 2] << 16) |
          (bytes[position + 3] << 24)) >>>
        0
      : ((bytes[position] << 24) |
          (bytes[position + 1] << 16) |
          (bytes[position + 2] << 8) |
          bytes[position + 3]) >>>
        0;
  const directory = start + read32(start + 4);
  if (directory + 2 > bytes.length) return 1;
  const count = read16(directory);
  for (let index = 0; index < count; index += 1) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > bytes.length) return 1;
    if (read16(entry) === 0x0112) {
      const value = read16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function jpegTiffOffset(bytes) {
  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) return -1;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (offset + 4 > bytes.length) return -1;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (marker === 0xe1) {
      const segment = offset + 4;
      return hasExifHeader(bytes, segment) ? segment + 6 : -1;
    }
    offset += 2 + length;
  }
  return -1;
}

function webpTiffOffset(bytes) {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size =
      bytes[offset + 4] |
      (bytes[offset + 5] << 8) |
      (bytes[offset + 6] << 16) |
      (bytes[offset + 7] << 24);
    const data = offset + 8;
    if (id === 'EXIF') {
      if (data + size > bytes.length) return -1;
      return size >= 6 && hasExifHeader(bytes, data) ? data + 6 : data;
    }
    offset = data + size + (size % 2);
  }
  return -1;
}

function exifOrientation(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const offset = jpegTiffOffset(bytes);
    return offset < 0 ? 1 : readOrientationFromTiff(bytes, offset);
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    const offset = webpTiffOffset(bytes);
    return offset < 0 ? 1 : readOrientationFromTiff(bytes, offset);
  }
  return 1;
}

function rotate90(image, destinationIndex) {
  const width = image.get_width();
  const height = image.get_height();
  const source = image.get_raw_pixels();
  const destination = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = (y * width + x) * 4;
      const destinationOffset = destinationIndex(x, y, width, height) * 4;
      destination.set(
        source.subarray(sourceOffset, sourceOffset + 4),
        destinationOffset,
      );
    }
  }
  return new photon.PhotonImage(destination, height, width);
}

function orient(image, bytes) {
  switch (exifOrientation(bytes)) {
    case 2:
      photon.fliph(image);
      return image;
    case 3:
      photon.fliph(image);
      photon.flipv(image);
      return image;
    case 4:
      photon.flipv(image);
      return image;
    case 5: {
      const rotated = rotate90(
        image,
        (x, y, _width, height) => x * height + (height - 1 - y),
      );
      photon.fliph(rotated);
      return rotated;
    }
    case 6:
      return rotate90(
        image,
        (x, y, _width, height) => x * height + (height - 1 - y),
      );
    case 7: {
      const rotated = rotate90(
        image,
        (x, y, width, height) => (width - 1 - x) * height + y,
      );
      photon.fliph(rotated);
      return rotated;
    }
    case 8:
      return rotate90(
        image,
        (x, y, width, height) => (width - 1 - x) * height + y,
      );
    default:
      return image;
  }
}

function run() {
  const bytes = new Uint8Array(workerData.bytes);
  const region = workerData.crop;
  let decoded;
  let source;
  let cropped;
  try {
    decoded = photon.PhotonImage.new_from_byteslice(bytes);
    source = orient(decoded, bytes);
    const sourceWidth = source.get_width();
    const sourceHeight = source.get_height();
    const right = region.x + region.width;
    const bottom = region.y + region.height;
    if (right > sourceWidth || bottom > sourceHeight) {
      throw new Error(
        `Image crop (${region.x},${region.y},${region.width},${region.height}) exceeds source bounds ${sourceWidth}x${sourceHeight}.`,
      );
    }
    cropped = photon.crop(source, region.x, region.y, right, bottom);
    const data = Buffer.from(cropped.get_bytes()).toString('base64');
    if (Buffer.byteLength(data, 'utf8') > workerData.maxEncodedBytes) {
      throw new Error(
        'Cropped PNG exceeds the 4.5MB attachment limit; request a smaller region.',
      );
    }
    return {
      data,
      mimeType: 'image/png',
      sourceWidth,
      sourceHeight,
      width: region.width,
      height: region.height,
    };
  } finally {
    cropped?.free();
    if (source && source !== decoded) source.free();
    decoded?.free();
  }
}

try {
  parentPort.postMessage({ result: run() });
} catch (error) {
  parentPort.postMessage({
    error: error instanceof Error ? error.message : 'Image crop failed.',
  });
}
