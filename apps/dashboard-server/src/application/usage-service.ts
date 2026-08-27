import type {
  UsageHistoryRange,
  UsageHistoryResponse,
} from '@pi-dashboard/protocol';
import {
  normalizeUsageHistorySamples,
  type SqliteUsageHistoryRepository,
} from '../repositories/sqlite-usage-history-repository.js';
import type { UsageProvider } from '../usage.js';

const MAX_USAGE_BYTES = 256 * 1024;
const DEFAULT_FRESH_MS = 30_000;
const DEFAULT_POLL_MS = 60_000;

export interface UsageResult {
  usage: unknown;
  error?: string;
}

export interface UsageServiceOptions {
  freshMs?: () => number;
  pollMs?: number;
  history?: Pick<SqliteUsageHistoryRepository, 'append' | 'read'>;
  now?: () => number;
}

/** Bounded, coalescing usage provider cache independent of HTTP requests. */
export class UsageService {
  private snapshot: unknown;
  private updatedAt = 0;
  private attemptedAt = 0;
  private request: Promise<unknown> | undefined;
  private requestController: AbortController | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly provider: UsageProvider,
    private readonly onChange?: () => void,
    private readonly options: UsageServiceOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(
      () => void this.refresh(),
      this.options.pollMs ?? DEFAULT_POLL_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.requestController?.abort(new Error('Usage service stopped.'));
  }

  cached(): unknown {
    return this.snapshot;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private freshMs(): number {
    return Math.max(0, this.options.freshMs?.() ?? DEFAULT_FRESH_MS);
  }

  history(range: UsageHistoryRange): UsageHistoryResponse {
    return (
      this.options.history?.read(range, this.now()) ?? {
        range,
        generatedAt: this.now(),
        series: [],
      }
    );
  }

  private async refresh(): Promise<UsageResult> {
    const freshnessBase = this.updatedAt || this.attemptedAt;
    if (freshnessBase && this.now() - freshnessBase < this.freshMs())
      return { usage: this.snapshot };
    return this.get();
  }

  async get(force = false): Promise<UsageResult> {
    try {
      if (
        !force &&
        this.snapshot !== undefined &&
        this.now() - this.updatedAt < this.freshMs()
      )
        return { usage: this.snapshot };
      if (this.request) {
        await this.request;
        return { usage: this.snapshot };
      }
      const controller = new AbortController();
      this.requestController = controller;
      this.attemptedAt = this.now();
      const request = this.provider.get(controller.signal);
      this.request = request;
      let usage: unknown;
      try {
        usage = await request;
      } finally {
        if (this.request === request) this.request = undefined;
        if (this.requestController === controller)
          this.requestController = undefined;
      }
      const serialized = JSON.stringify(usage);
      if (
        serialized === undefined ||
        Buffer.byteLength(serialized) > MAX_USAGE_BYTES
      )
        throw new Error('Usage payload exceeds the dashboard size limit.');
      const capturedAt = this.now();
      this.options.history?.append(
        normalizeUsageHistorySamples(usage, capturedAt),
      );
      this.snapshot = usage;
      this.updatedAt = capturedAt;
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
