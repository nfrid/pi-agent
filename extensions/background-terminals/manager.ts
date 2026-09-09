import {
  BACKGROUND_JOBS_MAX_WATCHES,
  type BackgroundJobSnapshot,
  type BackgroundJobStatus,
  type BackgroundJobsCapabilities,
  BackgroundJobsClient,
  type BackgroundWatchInput,
  type BackgroundWatchSnapshot,
  defaultProcessHostSocketPath,
  newBackgroundJobId,
  parseBackgroundWatchInput,
} from '@pi-agent/background-jobs';
import type { SessionScopeId } from '../shared/runtime/scoped-services';

export const MAX_RUNNING = 8;
export const MAX_SETTLED = 32;
export const MAX_WATCHES = BACKGROUND_JOBS_MAX_WATCHES;
export const STDOUT_RETAINED_BYTES = 256 * 1024;
export const STDERR_RETAINED_BYTES = 128 * 1024;
const DISPLAY_COMMAND_CHARS = 1_000;

export type BackgroundStatus = BackgroundJobStatus;
export type BackgroundSnapshot = BackgroundJobSnapshot;

export interface StartOptions {
  readonly command: string;
  readonly title?: string;
  readonly cwd: string;
  readonly watch?: readonly BackgroundWatchInput[];
}

export interface BackgroundJobsTransport {
  start(input: {
    id: string;
    command: string;
    title: string;
    cwd: string;
    watch?: readonly BackgroundWatchInput[];
  }): Promise<BackgroundSnapshot>;
  list(): Promise<BackgroundSnapshot[]>;
  inspect(id: string): Promise<BackgroundSnapshot | undefined>;
  stop(ids: readonly string[]): Promise<BackgroundSnapshot[]>;
  info?(): Promise<BackgroundJobsCapabilities>;
  watch?(
    id: string,
    watch: readonly BackgroundWatchInput[],
  ): Promise<BackgroundSnapshot>;
  unwatch?(
    id: string,
    watchIds: readonly string[],
  ): Promise<BackgroundSnapshot>;
  acknowledgeWatches?(id: string, watchIds: readonly string[]): Promise<void>;
  markDelivered?(id: string): Promise<void>;
}

export interface BackgroundManagerOptions {
  readonly scopeId?: SessionScopeId;
  readonly onSettled?: (snapshot: BackgroundSnapshot) => unknown;
  readonly onWatchSettled?: (
    snapshot: BackgroundSnapshot,
    watch: BackgroundWatchSnapshot,
  ) => unknown;
  readonly onWatchesRemoved?: (id: string, watchIds: readonly string[]) => void;
  readonly onChange?: () => void;
  readonly client?: BackgroundJobsTransport;
  readonly socketPath?: string;
}

function displayCommand(command: string): string {
  return command.length <= DISPLAY_COMMAND_CHARS
    ? command
    : `${command.slice(0, DISPLAY_COMMAND_CHARS)}…`;
}

function deriveTitle(command: string): string {
  return (
    command
      .split(/[\r\n]/u, 1)[0]
      ?.trim()
      .replace(/\s+/gu, ' ')
      .slice(0, 80) || 'process'
  );
}

function displaySnapshot(snapshot: BackgroundSnapshot): BackgroundSnapshot {
  return { ...snapshot, command: displayCommand(snapshot.command) };
}

function isBackgroundTerminalSnapshot(snapshot: BackgroundSnapshot): boolean {
  // Exact-environment rows are owned by the delegate adapter. They share the
  // process host, but must never be adopted, controlled, delivered, or ACKed
  // through the ordinary background-terminal lifecycle.
  return snapshot.exactEnv !== true;
}

function watchKey(id: string, watchId: string): string {
  return `${id}:${watchId}`;
}

export interface EndedWatch {
  readonly id: string;
  readonly contains: string;
  readonly stream?: 'stdout' | 'stderr';
}

/** Ended watches coalesce into the process completion while it is pending. */
export function endedWatches(snapshot: BackgroundSnapshot): EndedWatch[] {
  return (snapshot.watches ?? [])
    .filter((watch) => watch.status === 'ended' && !watch.delivered)
    .map(({ id, contains, stream }) => ({
      id,
      contains,
      ...(stream ? { stream } : {}),
    }));
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(
      Object.assign(new Error('The operation was aborted.'), {
        name: 'AbortError',
      }),
    );
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        Object.assign(new Error('The operation was aborted.'), {
          name: 'AbortError',
        }),
      );
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Session-scoped view of jobs owned by the stable process-host sidecar. */
export class BackgroundManager {
  private readonly client: BackgroundJobsTransport;
  private readonly records = new Map<string, BackgroundSnapshot>();
  private readonly observing = new Set<string>();
  private readonly notified = new Set<string>();
  private readonly notifiedWatches = new Set<string>();
  private readonly delivering = new Set<string>();
  private readonly deliveringWatches = new Set<string>();
  private readonly cancelledWatches = new Set<string>();
  private generation = 0;
  private readonly onSettled?: (snapshot: BackgroundSnapshot) => unknown;
  private readonly onWatchSettled?: (
    snapshot: BackgroundSnapshot,
    watch: BackgroundWatchSnapshot,
  ) => unknown;
  private readonly onWatchesRemoved?: (
    id: string,
    watchIds: readonly string[],
  ) => void;
  private readonly onChange?: () => void;
  private pollTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(options: BackgroundManagerOptions = {}) {
    const ownerSession = options.scopeId ?? 'default';
    this.client =
      options.client ??
      new BackgroundJobsClient(
        options.socketPath ?? defaultProcessHostSocketPath(),
        ownerSession,
      );
    this.onSettled = options.onSettled;
    this.onWatchSettled = options.onWatchSettled;
    this.onWatchesRemoved = options.onWatchesRemoved;
    this.onChange = options.onChange;
    void this.refresh(true, this.generation).catch(() => undefined);
    this.pollTimer = setInterval(() => {
      void this.refresh(true, this.generation).catch(() => undefined);
    }, 250);
    this.pollTimer.unref?.();
  }

  async start(options: StartOptions): Promise<BackgroundSnapshot> {
    this.assertLive();
    const generation = this.generation;
    await this.refresh(true, generation);
    this.assertAccepting();
    validateWatches(options.watch);
    if (options.watch?.length) await this.assertWatchSupport();
    this.assertLive();
    const snapshot = await this.client.start({
      id: newBackgroundJobId(),
      command: options.command,
      title: displayCommand(options.title ?? deriveTitle(options.command)),
      cwd: options.cwd,
      ...(options.watch?.length ? { watch: options.watch } : {}),
    });
    if (this.disposed || generation !== this.generation)
      throw new Error('Background manager is shut down.');
    if (!isBackgroundTerminalSnapshot(snapshot))
      throw new Error('Process host returned an incompatible background job.');
    this.accept(snapshot, true);
    return this.records.get(snapshot.id) ?? snapshot;
  }

  get(id: string): BackgroundSnapshot | undefined {
    return this.records.get(id);
  }

  async inspect(id: string): Promise<BackgroundSnapshot | undefined> {
    this.assertLive();
    const generation = this.generation;
    await this.refresh(false, generation);
    if (!this.records.has(id)) return undefined;
    const snapshot = await this.client.inspect(id);
    if (this.disposed || generation !== this.generation)
      throw new Error('Background manager is shut down.');
    if (!snapshot) return undefined;
    this.accept(snapshot, false);
    if (!isBackgroundTerminalSnapshot(snapshot)) {
      this.onChange?.();
      return undefined;
    }
    return displaySnapshot(snapshot);
  }

  async list(): Promise<BackgroundSnapshot[]> {
    this.assertLive();
    const generation = this.generation;
    await this.refresh(true, generation);
    return generation === this.generation ? [...this.records.values()] : [];
  }

  /** Immediate observational snapshot; this operation never waits. */
  async peek(id: string, signal?: AbortSignal): Promise<BackgroundSnapshot> {
    this.assertLive();
    const generation = this.generation;
    await this.refresh(false, generation);
    if (!this.records.has(id))
      throw new Error(`Unknown background process "${id}".`);
    this.observing.add(id);
    try {
      const snapshot = await withAbort(this.client.inspect(id), signal);
      if (this.disposed || generation !== this.generation)
        throw new Error('Background manager is shut down.');
      if (!snapshot || !isBackgroundTerminalSnapshot(snapshot)) {
        if (snapshot) this.accept(snapshot, false);
        throw new Error(`Unknown background process "${id}".`);
      }
      this.accept(snapshot, false);
      if (snapshot.status !== 'running') {
        const ended = endedWatches(snapshot);
        const watchIds = ended.map((watch) => watch.id);
        for (const watchId of watchIds)
          this.notifiedWatches.add(watchKey(id, watchId));
        try {
          if (watchIds.length)
            await this.client.acknowledgeWatches?.(id, watchIds);
          this.notified.add(id);
          await this.client.markDelivered?.(id);
        } catch (error) {
          this.notified.delete(id);
          for (const watchId of watchIds)
            this.notifiedWatches.delete(watchKey(id, watchId));
          throw error;
        }
        if (this.disposed || generation !== this.generation)
          throw new Error('Background manager is shut down.');
      }
      return displaySnapshot(snapshot);
    } finally {
      this.observing.delete(id);
    }
  }

  async watch(
    id: string,
    watches: readonly BackgroundWatchInput[],
  ): Promise<BackgroundSnapshot> {
    this.assertLive();
    validateWatches(watches);
    if (watches.length === 0) throw new Error('watch is required.');
    await this.assertWatchSupport();
    const generation = this.generation;
    await this.refresh(false, generation);
    const current = this.records.get(id);
    if (!current) throw new Error(`Unknown background process "${id}".`);
    const retained = current.watches?.length ?? 0;
    if (retained + watches.length > MAX_WATCHES)
      throw new Error(
        `At most ${MAX_WATCHES} watches may be retained per process.`,
      );
    if (current.status !== 'running')
      throw new Error(`Background process "${id}" is not running.`);
    if (!this.client.watch)
      throw new Error('Background host does not support watches.');
    const snapshot = await this.client.watch(id, watches);
    if (this.disposed || generation !== this.generation)
      throw new Error('Background manager is shut down.');
    this.accept(snapshot, true);
    return displaySnapshot(snapshot);
  }

  async unwatch(
    id: string,
    watchIds: readonly string[],
  ): Promise<BackgroundSnapshot> {
    this.assertLive();
    const unique = [...new Set(watchIds)].filter(Boolean);
    if (unique.length === 0) throw new Error('watch_ids is required.');
    const generation = this.generation;
    if (!this.client.unwatch)
      throw new Error('Background host does not support watches.');
    // Cancel locally before refresh or the host round trip so a queued
    // notification cannot win a race with an unwatch request.
    for (const watchId of unique) {
      const key = watchKey(id, watchId);
      this.cancelledWatches.add(key);
      this.notifiedWatches.delete(key);
      this.deliveringWatches.delete(key);
    }
    this.observing.add(id);
    this.notified.delete(id);
    this.onWatchesRemoved?.(id, unique);
    let snapshot: BackgroundSnapshot;
    try {
      await this.refresh(false, generation);
      if (!this.records.has(id))
        throw new Error(`Unknown background process "${id}".`);
      snapshot = await this.client.unwatch(id, unique);
    } catch (error) {
      for (const watchId of unique)
        this.cancelledWatches.delete(watchKey(id, watchId));
      throw error;
    } finally {
      this.observing.delete(id);
    }
    if (this.disposed || generation !== this.generation)
      throw new Error('Background manager is shut down.');
    this.accept(snapshot, true);
    return displaySnapshot(snapshot);
  }

  async stop(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<BackgroundSnapshot[]> {
    this.assertLive();
    const generation = this.generation;
    const requested = [...new Set(ids)];
    for (const id of requested) {
      this.observing.add(id);
      const watchIds =
        this.records.get(id)?.watches?.map((watch) => watch.id) ?? [];
      this.onWatchesRemoved?.(id, watchIds);
      for (const watchId of watchIds)
        this.notifiedWatches.delete(watchKey(id, watchId));
    }
    try {
      await this.refresh(false, generation);
      const unique = requested.filter((id) => this.records.has(id));
      if (unique.length === 0) return [];
      const responses = await withAbort(this.client.stop(unique), signal);
      if (this.disposed || generation !== this.generation)
        throw new Error('Background manager is shut down.');
      for (const snapshot of responses)
        if (!isBackgroundTerminalSnapshot(snapshot))
          this.accept(snapshot, false);
      const snapshots = responses.filter(isBackgroundTerminalSnapshot);
      for (const snapshot of snapshots) {
        this.accept(snapshot, false);
        this.cancelWatches(snapshot);
        const watchIds = snapshot.watches?.map((watch) => watch.id) ?? [];
        if (watchIds.length) {
          for (const watchId of watchIds)
            this.notifiedWatches.add(watchKey(snapshot.id, watchId));
          await this.client.acknowledgeWatches?.(snapshot.id, watchIds);
        }
        if (snapshot.status !== 'running') {
          this.notified.add(snapshot.id);
          await this.client.markDelivered?.(snapshot.id);
          if (this.disposed || generation !== this.generation)
            throw new Error('Background manager is shut down.');
        }
      }
      this.onChange?.();
      return snapshots.map(displaySnapshot);
    } catch (error) {
      // A failed stop or ACK must not permanently silence a still-owned job.
      for (const id of requested) {
        this.notified.delete(id);
        for (const watch of this.records.get(id)?.watches ?? []) {
          const key = watchKey(id, watch.id);
          this.cancelledWatches.delete(key);
          this.notifiedWatches.delete(key);
        }
      }
      throw error;
    } finally {
      for (const id of requested) this.observing.delete(id);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.records.clear();
    this.onChange?.();
    // Detach only. The sidecar remains the owner and jobs and watches persist.
  }

  get runningCount(): number {
    let count = 0;
    for (const snapshot of this.records.values())
      if (snapshot.status === 'running') count++;
    return count;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Background manager is shut down.');
  }

  private assertAccepting(): void {
    this.assertLive();
    if (this.runningCount >= MAX_RUNNING)
      throw new Error(
        `At most ${MAX_RUNNING} background processes may run at once.`,
      );
  }

  private async assertWatchSupport(): Promise<void> {
    const capabilities = await this.client.info?.();
    if (capabilities?.outputWatches !== true)
      throw new Error(
        'The running process host does not support output watches. Upgrade it in a quiet window; restarting it terminates active jobs.',
      );
  }

  private async refresh(
    notify: boolean,
    generation = this.generation,
  ): Promise<void> {
    if (this.disposed || generation !== this.generation)
      throw new Error('Background manager is shut down.');
    const snapshots = (await this.client.list()).filter(
      isBackgroundTerminalSnapshot,
    );
    if (this.disposed || generation !== this.generation)
      throw new Error('Background manager is shut down.');
    for (const snapshot of snapshots) this.accept(snapshot, notify);

    const known = new Set(snapshots.map((snapshot) => snapshot.id));
    for (const id of this.records.keys())
      if (!known.has(id)) this.records.delete(id);
    this.onChange?.();
  }

  private accept(snapshot: BackgroundSnapshot, notify: boolean): void {
    if (!isBackgroundTerminalSnapshot(snapshot)) {
      this.records.delete(snapshot.id);
      return;
    }
    const displayed = displaySnapshot(snapshot);
    this.records.set(displayed.id, displayed);
    if (displayed.completionDelivered) this.notified.add(displayed.id);
    for (const watch of displayed.watches ?? []) {
      if (watch.delivered)
        this.notifiedWatches.add(watchKey(displayed.id, watch.id));
      if (
        notify &&
        watch.status !== 'pending' &&
        !watch.delivered &&
        !this.notifiedWatches.has(watchKey(displayed.id, watch.id)) &&
        !this.observing.has(displayed.id) &&
        !(
          displayed.status !== 'running' &&
          watch.status === 'ended' &&
          !displayed.completionDelivered
        )
      )
        this.notifyWatch(displayed, watch);
    }
    if (
      notify &&
      displayed.status !== 'running' &&
      !this.notified.has(displayed.id) &&
      !this.observing.has(displayed.id)
    )
      this.notifyCompletion(displayed);
  }

  private notifyCompletion(snapshot: BackgroundSnapshot): void {
    if (this.delivering.has(snapshot.id)) return;
    const generation = this.generation;
    this.delivering.add(snapshot.id);
    void this.client
      .inspect(snapshot.id)
      .then(async (inspected) => {
        if (
          this.disposed ||
          generation !== this.generation ||
          this.notified.has(snapshot.id) ||
          this.observing.has(snapshot.id) ||
          !inspected ||
          !isBackgroundTerminalSnapshot(inspected) ||
          inspected.completionDelivered
        )
          return false;
        const latest = this.records.get(snapshot.id);
        if (!latest || latest.status === 'running') return false;
        const detailed = displaySnapshot({
          ...inspected,
          ...(inspected.watches
            ? {
                watches: inspected.watches.filter(
                  (watch) =>
                    !this.cancelledWatches.has(watchKey(snapshot.id, watch.id)),
                ),
              }
            : {}),
        });
        this.records.set(detailed.id, detailed);
        const delivered = await this.onSettled?.(detailed);
        return delivered !== false;
      })
      .then((delivered) => {
        if (delivered) this.notified.add(snapshot.id);
      })
      .catch(() => undefined)
      .finally(() => this.delivering.delete(snapshot.id));
  }

  private notifyWatch(
    snapshot: BackgroundSnapshot,
    watch: BackgroundWatchSnapshot,
  ): void {
    const key = watchKey(snapshot.id, watch.id);
    const generation = this.generation;
    if (this.deliveringWatches.has(key) || this.cancelledWatches.has(key))
      return;
    this.deliveringWatches.add(key);
    void Promise.resolve()
      .then(() => {
        const latest = this.records.get(snapshot.id);
        const current = latest?.watches?.find((item) => item.id === watch.id);
        if (
          this.disposed ||
          generation !== this.generation ||
          this.cancelledWatches.has(key) ||
          this.observing.has(snapshot.id) ||
          this.notifiedWatches.has(key) ||
          !latest ||
          !current ||
          current.status === 'pending' ||
          current.delivered
        )
          return false;
        return this.onWatchSettled?.(latest, current);
      })
      .then((delivered) => {
        if (
          delivered !== false &&
          generation === this.generation &&
          !this.cancelledWatches.has(key) &&
          !this.disposed
        )
          this.notifiedWatches.add(key);
      })
      .catch(() => undefined)
      .finally(() => this.deliveringWatches.delete(key));
  }

  private cancelWatches(snapshot: BackgroundSnapshot): void {
    const ids = snapshot.watches?.map((watch) => watch.id) ?? [];
    if (!ids.length) return;
    this.onWatchesRemoved?.(snapshot.id, ids);
    for (const id of ids) {
      const key = watchKey(snapshot.id, id);
      this.cancelledWatches.add(key);
      this.deliveringWatches.delete(key);
      this.notifiedWatches.add(key);
    }
  }

  async acknowledgeEntered(messages: readonly unknown[]): Promise<void> {
    if (this.disposed) return;
    const generation = this.generation;
    const completions = new Set<string>();
    const watches = new Map<string, Set<string>>();
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const value = message as { customType?: unknown; details?: unknown };
      if (!value.details || typeof value.details !== 'object') continue;
      const details = value.details as {
        id?: unknown;
        watchId?: unknown;
        dedupeKey?: unknown;
        status?: unknown;
        endedWatches?: unknown;
      };
      if (value.customType === 'background-terminal-result') {
        if (
          typeof details.id === 'string' &&
          details.dedupeKey === details.id &&
          (details.status === 'done' ||
            details.status === 'failed' ||
            details.status === 'killed') &&
          this.records.get(details.id)?.status !== 'running' &&
          this.records.has(details.id)
        ) {
          completions.add(details.id);
          if (Array.isArray(details.endedWatches)) {
            for (const item of details.endedWatches) {
              if (!item || typeof item !== 'object') continue;
              const ended = item as { id?: unknown };
              if (typeof ended.id !== 'string') continue;
              const current = this.records.get(details.id);
              if (
                current &&
                current.status !== 'running' &&
                endedWatches(current).some((watch) => watch.id === ended.id)
              ) {
                let ids = watches.get(details.id);
                if (!ids) {
                  ids = new Set();
                  watches.set(details.id, ids);
                }
                ids.add(ended.id);
              }
            }
          }
        }
      } else if (
        value.customType === 'background-watch-result' &&
        typeof details.id === 'string' &&
        typeof details.watchId === 'string' &&
        details.dedupeKey === watchKey(details.id, details.watchId) &&
        this.records
          .get(details.id)
          ?.watches?.some(
            (watch) =>
              watch.id === details.watchId &&
              watch.status !== 'pending' &&
              !watch.delivered,
          )
      ) {
        let ids = watches.get(details.id);
        if (!ids) {
          ids = new Set();
          watches.set(details.id, ids);
        }
        ids.add(details.watchId);
      }
    }
    // Acknowledge included watches first. Never persist completion while an
    // included watch ACK has failed, which would split recovery into two alerts.
    for (const [id, ids] of watches) {
      if (this.disposed || generation !== this.generation) return;
      for (const watchId of ids)
        this.notifiedWatches.add(watchKey(id, watchId));
      try {
        await this.client.acknowledgeWatches?.(id, [...ids]);
      } catch (error) {
        for (const watchId of ids)
          this.notifiedWatches.delete(watchKey(id, watchId));
        if (completions.has(id)) this.notified.delete(id);
        throw error;
      }
    }
    for (const id of completions) {
      if (this.disposed || generation !== this.generation) return;
      this.notified.add(id);
      try {
        await this.client.markDelivered?.(id);
      } catch (error) {
        this.notified.delete(id);
        throw error;
      }
    }
  }
}

function validateWatches(watches?: readonly BackgroundWatchInput[]): void {
  if (!watches) return;
  if (watches.length > MAX_WATCHES)
    throw new Error(
      `At most ${MAX_WATCHES} watches may be retained per process.`,
    );
  for (const watch of watches) parseBackgroundWatchInput(watch);
}
