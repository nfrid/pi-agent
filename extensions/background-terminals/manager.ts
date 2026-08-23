import {
  type BackgroundJobSnapshot,
  type BackgroundJobStatus,
  BackgroundJobsClient,
  defaultProcessHostSocketPath,
  newBackgroundJobId,
} from '@pi-agent/background-jobs';
import type {
  PendingProcessAccounting,
  SessionScopeId,
} from '../shared/runtime/scoped-services';

export const MAX_RUNNING = 8;
export const MAX_SETTLED = 32;
export const STDOUT_RETAINED_BYTES = 256 * 1024;
export const STDERR_RETAINED_BYTES = 128 * 1024;
const DISPLAY_COMMAND_CHARS = 1_000;

export type BackgroundStatus = BackgroundJobStatus;
export type BackgroundSnapshot = BackgroundJobSnapshot;

export interface StartOptions {
  readonly command: string;
  readonly title: string;
  readonly cwd: string;
}

export interface BackgroundJobsTransport {
  start(input: {
    id: string;
    command: string;
    title: string;
    cwd: string;
  }): Promise<BackgroundSnapshot>;
  list(): Promise<BackgroundSnapshot[]>;
  inspect(id: string): Promise<BackgroundSnapshot | undefined>;
  wait(id: string, waitMs?: number): Promise<BackgroundSnapshot>;
  stop(ids: readonly string[]): Promise<BackgroundSnapshot[]>;
  markDelivered?(id: string): Promise<void>;
}

export interface BackgroundManagerOptions {
  readonly scopeId?: SessionScopeId;
  readonly pendingProcesses?: PendingProcessAccounting;
  readonly onSettled?: (snapshot: BackgroundSnapshot) => unknown;
  readonly onChange?: () => void;
  readonly client?: BackgroundJobsTransport;
  readonly socketPath?: string;
}

function displayCommand(command: string): string {
  return command.length <= DISPLAY_COMMAND_CHARS
    ? command
    : `${command.slice(0, DISPLAY_COMMAND_CHARS)}…`;
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
  private readonly pendingProcesses?: PendingProcessAccounting;
  private readonly records = new Map<string, BackgroundSnapshot>();
  private readonly observing = new Set<string>();
  private readonly notified = new Set<string>();
  private generation = 0;
  private readonly onSettled?: (snapshot: BackgroundSnapshot) => unknown;
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
    this.pendingProcesses = options.pendingProcesses;
    this.onSettled = options.onSettled;
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
    const snapshot = await this.client.start({
      id: newBackgroundJobId(),
      command: options.command,
      title: displayCommand(options.title),
      cwd: options.cwd,
    });
    if (this.disposed || generation !== this.generation)
      throw new Error('Background manager is shut down.');
    if (!isBackgroundTerminalSnapshot(snapshot))
      throw new Error('Process host returned an incompatible background job.');
    this.accept(snapshot, true);
    return this.records.get(snapshot.id) ?? snapshot;
  }

  /** Synchronous cache lookup retained for widgets and lightweight callers. */
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
      this.syncPending();
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

  async peek(
    id: string,
    waitMs = 0,
    signal?: AbortSignal,
  ): Promise<BackgroundSnapshot> {
    this.assertLive();
    const generation = this.generation;
    await this.refresh(false, generation);
    if (!this.records.has(id))
      throw new Error(`Unknown background process "${id}".`);
    this.observing.add(id);
    try {
      const snapshot = await withAbort(
        this.client.wait(id, Math.max(0, Math.floor(waitMs))),
        signal,
      );
      if (this.disposed || generation !== this.generation)
        throw new Error('Background manager is shut down.');
      if (!isBackgroundTerminalSnapshot(snapshot)) {
        this.accept(snapshot, false);
        this.syncPending();
        this.onChange?.();
        throw new Error(`Unknown background process "${id}".`);
      }
      this.accept(snapshot, false);
      if (snapshot.status !== 'running') {
        this.notified.add(id);
        await this.client.markDelivered?.(id);
        if (this.disposed || generation !== this.generation)
          throw new Error('Background manager is shut down.');
      }
      return displaySnapshot(snapshot);
    } finally {
      this.observing.delete(id);
    }
  }

  async stop(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<BackgroundSnapshot[]> {
    this.assertLive();
    const generation = this.generation;
    await this.refresh(false, generation);
    const unique = [...new Set(ids)].filter((id) => this.records.has(id));
    if (unique.length === 0) return [];
    for (const id of unique) this.observing.add(id);
    try {
      const responses = await withAbort(this.client.stop(unique), signal);
      if (this.disposed || generation !== this.generation)
        throw new Error('Background manager is shut down.');
      for (const snapshot of responses)
        if (!isBackgroundTerminalSnapshot(snapshot))
          this.accept(snapshot, false);
      const snapshots = responses.filter(isBackgroundTerminalSnapshot);
      for (const snapshot of snapshots) {
        this.accept(snapshot, false);
        if (snapshot.status !== 'running') {
          this.notified.add(snapshot.id);
          await this.client.markDelivered?.(snapshot.id);
          if (this.disposed || generation !== this.generation)
            throw new Error('Background manager is shut down.');
        }
      }
      this.syncPending();
      this.onChange?.();
      return snapshots.map(displaySnapshot);
    } finally {
      for (const id of unique) this.observing.delete(id);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.records.clear();
    this.pendingProcesses?.set(this, 0);
    this.onChange?.();
    // Detach only. The sidecar remains the owner and jobs are intentionally not stopped.
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
    this.syncPending();
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
    if (
      notify &&
      displayed.status !== 'running' &&
      !this.notified.has(displayed.id) &&
      !this.observing.has(displayed.id)
    ) {
      const delivered = this.onSettled?.(displayed);
      if (delivered !== false) this.notified.add(displayed.id);
    }
  }

  async acknowledgeEntered(messages: readonly unknown[]): Promise<void> {
    if (this.disposed) return;
    const generation = this.generation;
    const ids = new Set<string>();
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const value = message as {
        customType?: unknown;
        details?: unknown;
      };
      if (value.customType !== 'background-terminal-result') continue;
      if (!value.details || typeof value.details !== 'object') continue;
      const details = value.details as {
        id?: unknown;
        dedupeKey?: unknown;
        status?: unknown;
      };
      if (
        typeof details.id !== 'string' ||
        details.dedupeKey !== details.id ||
        (details.status !== 'done' &&
          details.status !== 'failed' &&
          details.status !== 'killed') ||
        this.records.get(details.id)?.status === 'running' ||
        !this.records.has(details.id)
      )
        continue;
      ids.add(details.id);
    }
    for (const id of ids) {
      if (this.disposed || generation !== this.generation) return;
      await this.client.markDelivered?.(id);
    }
  }

  private syncPending(): void {
    this.pendingProcesses?.set(this, this.runningCount);
  }
}
