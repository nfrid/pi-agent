import { createHash } from 'node:crypto';
import { createReadStream, type Dirent, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { boundedUsageTimestamp } from '@pi-dashboard/protocol';
import type {
  SessionUsageEvent,
  SessionUsageSource,
  SqliteSessionUsageRepository,
} from '../repositories/sqlite-session-usage-repository.js';

const FRESH_MS = 60_000;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function boundedText(value: unknown, fallback: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, max);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(value))
    : 0;
}

function cost(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function eventFromUsage(
  entry: RecordValue,
  usageValue: unknown,
  identity: { provider: string; modelId: string; label: string },
  sessionId?: string,
): SessionUsageEvent | undefined {
  const usage = record(usageValue);
  if (!usage) return undefined;
  const occurredAt = boundedUsageTimestamp(Date.parse(String(entry.timestamp)));
  if (occurredAt === undefined) return undefined;
  const costs = record(usage.cost);
  const inputTokens = count(usage.input);
  const outputTokens = count(usage.output);
  const cacheReadTokens = count(usage.cacheRead);
  const cacheWriteTokens = count(usage.cacheWrite);
  const totalTokens =
    count(usage.totalTokens) ||
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const costUsd =
    cost(costs?.total) ||
    cost(costs?.input) +
      cost(costs?.output) +
      cost(costs?.cacheRead) +
      cost(costs?.cacheWrite);
  if (totalTokens === 0 && costUsd === 0) return undefined;
  const provider = boundedText(identity.provider, 'unknown', 128);
  const modelId = boundedText(identity.modelId, 'unknown', 128);
  const label = boundedText(identity.label, modelId, 256);
  const keyPayload = JSON.stringify({
    sessionId,
    id: entry.id,
    type: entry.type,
    timestamp: entry.timestamp,
    provider,
    modelId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costUsd,
  });
  return {
    eventKey: createHash('sha256').update(keyPayload).digest('hex'),
    occurredAt,
    provider,
    modelId,
    label,
    calls: 1,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costUsd,
  };
}

/** Extracts one durable API-equivalent usage event without reading message text. */
export function sessionUsageEvent(
  entryValue: unknown,
  sessionId?: string,
): SessionUsageEvent | undefined {
  const entry = record(entryValue);
  if (!entry) return undefined;
  if (entry.type === 'message') {
    const message = record(entry.message);
    if (message?.role === 'assistant') {
      const modelId = boundedText(
        message.responseModel,
        boundedText(message.model, 'unknown', 128),
        128,
      );
      return eventFromUsage(
        entry,
        message.usage,
        {
          provider: boundedText(message.provider, 'unknown', 128),
          modelId,
          label: modelId,
        },
        sessionId,
      );
    }
    if (message?.role === 'toolResult' && message.usage)
      return eventFromUsage(
        entry,
        message.usage,
        {
          provider: 'pi',
          modelId: 'nested-tool-calls',
          label: 'Nested tool calls',
        },
        sessionId,
      );
    return undefined;
  }
  if (entry.type === 'compaction' && entry.usage)
    return eventFromUsage(
      entry,
      entry.usage,
      {
        provider: 'pi',
        modelId: 'compaction-summaries',
        label: 'Compaction summaries',
      },
      sessionId,
    );
  if (entry.type === 'branch_summary' && entry.usage)
    return eventFromUsage(
      entry,
      entry.usage,
      {
        provider: 'pi',
        modelId: 'branch-summaries',
        label: 'Branch summaries',
      },
      sessionId,
    );
  return undefined;
}

async function sessionFiles(
  root: string,
  signal: AbortSignal,
): Promise<string[] | undefined> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<boolean> => {
    signal.throwIfAborted();
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    let complete = true;
    for (const entry of entries) {
      signal.throwIfAborted();
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !(await visit(file))) complete = false;
      else if (entry.isFile() && entry.name.endsWith('.jsonl'))
        files.push(file);
    }
    return complete;
  };
  return (await visit(root)) ? files.sort() : undefined;
}

async function readEvents(
  file: string,
  signal: AbortSignal,
): Promise<{ events: SessionUsageEvent[]; fingerprint: string }> {
  signal.throwIfAborted();
  const events: SessionUsageEvent[] = [];
  const fingerprint = createHash('sha256');
  const input = createReadStream(file);
  input.on('data', (chunk) => fingerprint.update(chunk));
  const abort = () => input.destroy(signal.reason as Error | undefined);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const lines = readline.createInterface({
      input,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    let sessionId: string | undefined;
    for await (const line of lines) {
      signal.throwIfAborted();
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as unknown;
        const value = record(entry);
        if (value?.type === 'session' && typeof value.id === 'string')
          sessionId = boundedText(value.id, 'unknown', 256);
        const event = sessionUsageEvent(entry, sessionId);
        if (event) events.push(event);
      } catch {
        // A partial or malformed line must not poison the rest of the archive.
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
  return { events, fingerprint: fingerprint.digest('hex') };
}

/** Lazily and idempotently indexes live and archived Pi session usage. */
export class SessionUsageService {
  private refreshedAt = 0;
  private request: Promise<boolean> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;

  constructor(
    private readonly repository: SqliteSessionUsageRepository,
    private readonly roots: readonly string[],
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.stopped = false;
    void this.refresh().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller?.abort(new Error('Session usage indexing stopped.'));
    await this.request?.catch(() => undefined);
  }

  async read(periodStart: number, periodEnd: number, bucketMs: number) {
    await this.refresh().catch(() => undefined);
    return this.repository.read(periodStart, periodEnd, bucketMs);
  }

  private async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.request) {
      await this.request;
      return;
    }
    if (this.refreshedAt && this.now() - this.refreshedAt < FRESH_MS) return;
    const controller = new AbortController();
    this.controller = controller;
    const request = this.scan(controller.signal);
    this.request = request;
    try {
      if (await request) this.refreshedAt = this.now();
    } finally {
      if (this.request === request) this.request = undefined;
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private async scan(signal: AbortSignal): Promise<boolean> {
    const roots = await Promise.all(
      this.roots.map((root) => sessionFiles(root, signal)),
    );
    const complete = roots.every((files) => files !== undefined);
    const files = roots.flatMap((root) => root ?? []);
    for (const file of files) {
      signal.throwIfAborted();
      const stat = await fs.stat(file);
      const source: SessionUsageSource = {
        path: file,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        fingerprint: '',
      };
      const prior = this.repository.source(file);
      if (
        prior?.size === source.size &&
        prior.mtimeMs === source.mtimeMs &&
        prior.ctimeMs === source.ctimeMs
      )
        continue;
      const result = await readEvents(file, signal);
      source.fingerprint = result.fingerprint;
      signal.throwIfAborted();
      if (this.stopped) return false;
      this.repository.appendFile(source, result.events, this.now());
    }
    if (complete) this.repository.reconcileSources(files);
    return complete;
  }
}
