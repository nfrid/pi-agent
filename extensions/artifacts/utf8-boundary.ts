/** Byte index safe for decoding when `maximum` may fall inside a code point. */
export function utf8SafeEnd(bytes: Buffer, maximum: number): number {
  let end = Math.min(maximum, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return end;
}

export function utf8Head(bytes: Buffer, maximum: number): string {
  let end = Math.min(maximum, bytes.length);
  while (end > 0) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, end),
      );
    } catch {
      end -= 1;
    }
  }
  return '';
}

export function utf8Tail(bytes: Buffer, maximum: number): string {
  let start = Math.max(0, bytes.length - maximum);
  while (start < bytes.length) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(start),
      );
    } catch {
      start += 1;
    }
  }
  return '';
}

export function utf8Prefix(value: string, maximum: number) {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximum) return { text: value, bytes: bytes.length };
  const text = utf8Head(bytes, maximum);
  return { text, bytes: Buffer.byteLength(text, 'utf8') };
}

export function utf8Suffix(value: string, maximum: number) {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximum)
    return { text: value, bytes: bytes.length, omittedBytes: 0 };
  const text = utf8Tail(bytes, maximum);
  const textBytes = Buffer.byteLength(text, 'utf8');
  return { text, bytes: textBytes, omittedBytes: bytes.length - textBytes };
}
