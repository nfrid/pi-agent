import {
  type UsageHistoryRange,
  type UsageHistoryResponse,
  usageHistoryPeriod,
} from '@pi-dashboard/protocol';
import {
  normalizeUsageHistorySamples,
  type SqliteUsageHistoryRepository,
} from '../repositories/sqlite-usage-history-repository.js';
import type { UsageProvider } from '../usage.js';
import type { SessionUsageService } from './session-usage-service.js';

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
  sessionUsage?: Pick<SessionUsageService, 'start' | 'stop' | 'read'>;
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
  private stopped = false;

  constructor(
    private readonly provider: UsageProvider,
    private readonly onChange?: () => void,
    private readonly options: UsageServiceOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.options.sessionUsage?.start();
    void this.refresh();
    this.timer = setInterval(
      () => void this.refresh(),
      this.options.pollMs ?? DEFAULT_POLL_MS,
    );
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.requestController?.abort(new Error('Usage service stopped.'));
    await this.options.sessionUsage?.stop();
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

  async history(
    range: UsageHistoryRange,
    before?: number,
  ): Promise<UsageHistoryResponse> {
    const now = this.now();
    const period = usageHistoryPeriod(range, Math.min(before ?? now, now));
    const limits = this.options.history?.read(range, before, now) ?? {
      range,
      generatedAt: now,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      bucket: period.bucket,
      buckets: period.buckets,
      series: [],
    };
    const spend =
      (await this.options.sessionUsage?.read(
        limits.periodStart,
        limits.periodEnd,
        period.bucketMs,
      )) ?? [];
    return { ...limits, spend };
  }

  private async refresh(): Promise<UsageResult> {
    const freshnessBase = this.updatedAt || this.attemptedAt;
    if (freshnessBase && this.now() - freshnessBase < this.freshMs())
      return { usage: this.snapshot };
    return this.get();
  }

  async get(force = false): Promise<UsageResult> {
    try {
      if (this.stopped) throw new Error('Usage service stopped.');
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
      if (this.stopped || controller.signal.aborted)
        throw new Error('Usage service stopped.');
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
