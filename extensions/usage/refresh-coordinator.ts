export interface RefreshCoordinatorOptions<Context, Report> {
  debounceMs: number;
  query: (ctx: Context, signal: AbortSignal) => Promise<Report>;
  canRefresh: (ctx: Context) => boolean;
  isFresh: (report: Report, ctx: Context) => boolean;
  onLoading: (ctx: Context) => void;
  onReport: (report: Report, ctx: Context) => void;
  onError: (ctx: Context) => void;
  onClear: (ctx: Context) => void;
}

interface Batch<Context> {
  ctx: Context;
  generation: number;
  waiters: Array<() => void>;
}

/** Coordinates all usage refresh sources and owns their lifecycle generation. */
export class RefreshCoordinator<Context, Report> {
  private active = false;
  private generation = 0;
  private cache: Report | undefined;
  private inFlight = false;
  private trailing: Batch<Context> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private queryController: AbortController | undefined;

  constructor(
    private readonly options: RefreshCoordinatorOptions<Context, Report>,
  ) {}

  sessionStart(ctx: Context): Promise<void> {
    this.active = true;
    this.advanceGeneration();
    return this.request(ctx, true, true);
  }

  modelChanged(ctx: Context): Promise<void> {
    this.advanceGeneration();
    if (!this.active) return Promise.resolve();
    return this.request(ctx, true, true);
  }

  sessionShutdown(ctx: Context): void {
    this.active = false;
    this.advanceGeneration();
    this.options.onClear(ctx);
  }

  /** Debounce settled notifications and retain one refresh behind active work. */
  settled(ctx: Context): void {
    if (!this.active) return;
    this.clearDebounce();
    const generation = this.generation;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (!this.active || generation !== this.generation) return;
      void this.request(ctx, true, true);
    }, this.options.debounceMs);
    this.debounceTimer.unref?.();
  }

  periodic(ctx: Context): Promise<void> {
    return this.request(ctx, false, false);
  }

  manual(ctx: Context): Promise<void> {
    return this.request(ctx, true, true);
  }

  private advanceGeneration(): void {
    this.generation++;
    this.queryController?.abort();
    this.clearDebounce();
    if (this.trailing) {
      this.resolve(this.trailing);
      this.trailing = undefined;
    }
  }

  private clearDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  private request(
    ctx: Context,
    force: boolean,
    allowTrailing: boolean,
  ): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (!this.options.canRefresh(ctx)) {
      this.options.onClear(ctx);
      return Promise.resolve();
    }
    if (!force && this.cache && this.options.isFresh(this.cache, ctx)) {
      this.options.onReport(this.cache, ctx);
      return Promise.resolve();
    }

    let done: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
      done = resolve;
    });
    const waiter = done as () => void;

    if (this.inFlight) {
      if (!allowTrailing) {
        waiter();
        return promise;
      }
      if (!this.trailing || this.trailing.generation !== this.generation) {
        this.trailing = { ctx, generation: this.generation, waiters: [] };
      } else {
        this.trailing.ctx = ctx;
      }
      this.trailing.waiters.push(waiter);
      return promise;
    }

    this.start({ ctx, generation: this.generation, waiters: [waiter] });
    return promise;
  }

  private start(batch: Batch<Context>): void {
    this.inFlight = true;
    const controller = new AbortController();
    this.queryController = controller;
    if (this.isCurrent(batch)) this.options.onLoading(batch.ctx);

    void this.options
      .query(batch.ctx, controller.signal)
      .then((report) => {
        if (!this.isCurrent(batch) || !this.options.canRefresh(batch.ctx))
          return;
        this.cache = report;
        this.options.onReport(report, batch.ctx);
      })
      .catch(() => {
        if (this.isCurrent(batch) && this.options.canRefresh(batch.ctx)) {
          this.options.onError(batch.ctx);
        }
      })
      .finally(() => {
        if (this.queryController === controller)
          this.queryController = undefined;
        this.inFlight = false;
        this.resolve(batch);
        const trailing = this.trailing;
        this.trailing = undefined;
        if (trailing && this.isCurrent(trailing)) this.start(trailing);
        else if (trailing) this.resolve(trailing);
      });
  }

  private isCurrent(batch: Batch<Context>): boolean {
    return this.active && batch.generation === this.generation;
  }

  private resolve(batch: Batch<Context>): void {
    for (const waiter of batch.waiters) waiter();
  }
}
