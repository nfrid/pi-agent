import type { UsageProvider } from '../usage.js';

const MAX_USAGE_BYTES = 256 * 1024;
const CACHE_MS = 30_000;

export interface UsageResult {
  usage: unknown;
  error?: string;
}

/** Bounded, coalescing usage provider cache independent of HTTP requests. */
export class UsageService {
  private snapshot: unknown;
  private updatedAt = 0;
  private request: Promise<unknown> | undefined;

  constructor(
    private readonly provider: UsageProvider,
    private readonly onChange?: () => void,
  ) {}

  cached(): unknown {
    return this.snapshot;
  }

  async get(): Promise<UsageResult> {
    try {
      if (this.snapshot !== undefined && Date.now() - this.updatedAt < CACHE_MS)
        return { usage: this.snapshot };
      if (this.request) {
        await this.request;
        return { usage: this.snapshot };
      }
      const request = this.provider.get();
      this.request = request;
      let usage: unknown;
      try {
        usage = await request;
      } finally {
        if (this.request === request) this.request = undefined;
      }
      const serialized = JSON.stringify(usage);
      if (
        serialized === undefined ||
        Buffer.byteLength(serialized) > MAX_USAGE_BYTES
      )
        throw new Error('Usage payload exceeds the dashboard size limit.');
      this.snapshot = usage;
      this.updatedAt = Date.now();
      this.onChange?.();
      return { usage: this.snapshot };
    } catch (error) {
      return {
        usage: this.snapshot,
        error: error instanceof Error ? error.message : 'Usage unavailable.',
      };
    }
  }
}
