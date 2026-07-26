const COALESCE_BYTES = 4 * 1024;

export interface OutputSnapshot {
  readonly text: string;
  readonly totalBytes: number;
  readonly droppedBytes: number;
}

/** Bounded UTF-8 text tail fed by decoded Node stream chunks. */
export class OutputTail {
  private chunks: string[] = [];
  private retainedBytes = 0;
  private cachedText = '';
  private dirty = false;
  totalBytes = 0;
  droppedBytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: string): void {
    if (!chunk) return;

    const originalBytes = Buffer.byteLength(chunk);
    this.totalBytes += originalBytes;

    if (originalBytes > this.maxBytes) {
      this.droppedBytes += this.retainedBytes;
      this.chunks = [];
      this.retainedBytes = 0;

      const bytes = Buffer.from(chunk);
      let start = bytes.length - this.maxBytes;
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      this.droppedBytes += start;
      chunk = bytes.subarray(start).toString('utf8');
    }

    const chunkBytes = Buffer.byteLength(chunk);
    const lastIndex = this.chunks.length - 1;
    const last = this.chunks[lastIndex];
    const lastBytes = last === undefined ? 0 : Buffer.byteLength(last);
    if (
      last !== undefined &&
      lastBytes < COALESCE_BYTES &&
      lastBytes + chunkBytes <= this.maxBytes
    ) {
      this.chunks[lastIndex] = last + chunk;
    } else {
      this.chunks.push(chunk);
    }
    this.retainedBytes += chunkBytes;

    while (this.retainedBytes > this.maxBytes) {
      const first = this.chunks[0];
      if (first === undefined) break;
      const firstBuffer = Buffer.from(first);
      const excess = this.retainedBytes - this.maxBytes;
      if (firstBuffer.length <= excess && this.chunks.length > 1) {
        this.chunks.shift();
        this.retainedBytes -= firstBuffer.length;
        this.droppedBytes += firstBuffer.length;
        continue;
      }

      let start = Math.min(excess, firstBuffer.length);
      while (
        start < firstBuffer.length &&
        (firstBuffer[start] & 0xc0) === 0x80
      ) {
        start++;
      }
      this.chunks[0] = firstBuffer.subarray(start).toString('utf8');
      this.retainedBytes -= start;
      this.droppedBytes += start;
    }

    this.dirty = true;
  }

  snapshot(): OutputSnapshot {
    if (this.dirty) {
      this.cachedText = this.chunks.join('');
      this.dirty = false;
    }
    return {
      text: this.cachedText,
      totalBytes: this.totalBytes,
      droppedBytes: this.droppedBytes,
    };
  }
}
