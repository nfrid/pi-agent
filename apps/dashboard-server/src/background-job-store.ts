import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  BackgroundJobEvent,
  BackgroundJobEventsSnapshot,
  BackgroundJobSnapshot,
  BackgroundJobStatus,
  OutputSnapshot,
  StartBackgroundJobInput,
} from '@pi-agent/background-jobs';
import {
  BACKGROUND_JOBS_MAX_EVENT_BYTES,
  BACKGROUND_JOBS_MAX_EVENT_LINE_BYTES,
  BACKGROUND_JOBS_MAX_EVENT_RESPONSE_BYTES,
  parseBackgroundJobsEnv,
} from '@pi-agent/background-jobs';

const HOST_RESTART_ERROR =
  'Background job was marked failed because the process host restarted; the process was not adopted by PID.';

export interface BackgroundJobStoreRow extends BackgroundJobSnapshot {
  readonly fingerprint: string;
}

export function backgroundJobEventsDirectory(databasePath: string): string {
  return path.join(path.dirname(databasePath), 'background-job-events');
}

export function backgroundJobEventsPath(
  databasePath: string,
  id: string,
): string {
  return path.join(backgroundJobEventsDirectory(databasePath), `${id}.jsonl`);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number'
    ? value
    : typeof value === 'bigint'
      ? Number(value)
      : undefined;
}
function textValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function nullableNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : numberValue(value);
}
function boundedUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

type StoredEvent = { event: BackgroundJobEvent; endOffset: number };

function parseEventRecords(bytes: Buffer): StoredEvent[] {
  const records: StoredEvent[] = [];
  let start = 0;
  while (start < bytes.byteLength) {
    const newline = bytes.indexOf(0x0a, start);
    if (newline < 0) break;
    try {
      const parsed = JSON.parse(
        bytes.subarray(start, newline).toString('utf8'),
      ) as {
        offset?: unknown;
        stream?: unknown;
        text?: unknown;
      };
      if (
        typeof parsed.offset === 'number' &&
        Number.isSafeInteger(parsed.offset) &&
        parsed.offset >= 0 &&
        (parsed.stream === 'stdout' || parsed.stream === 'stderr') &&
        typeof parsed.text === 'string' &&
        Buffer.byteLength(parsed.text) <= BACKGROUND_JOBS_MAX_EVENT_LINE_BYTES
      )
        records.push({
          event: {
            offset: parsed.offset,
            stream: parsed.stream,
            text: parsed.text,
          },
          endOffset: parsed.offset + newline + 1 - start,
        });
    } catch {
      /* Ignore a corrupt record rather than making the host unavailable. */
    }
    start = newline + 1;
  }
  return records;
}

function nextEventOffset(bytes: Buffer): number {
  const records = parseEventRecords(bytes);
  const last = records.at(-1);
  return last ? last.endOffset : 0;
}

function retainEventBytes(bytes: Buffer, maxBytes: number): Buffer {
  let start = 0;
  while (bytes.byteLength - start > maxBytes) {
    const newline = bytes.indexOf(0x0a, start);
    if (newline < 0) return Buffer.alloc(0);
    start = newline + 1;
  }
  return bytes.subarray(start);
}

function snapshot(row: Record<string, unknown>): BackgroundJobStoreRow {
  let env: Readonly<Record<string, string>> | undefined;
  const storedEnv = textValue(row.env_json);
  if (storedEnv) {
    try {
      env = parseBackgroundJobsEnv(JSON.parse(storedEnv));
    } catch {
      env = undefined;
    }
  }
  return {
    id: String(row.id),
    ownerSession: String(row.owner_session),
    title: String(row.title),
    command: String(row.command),
    cwd: String(row.cwd),
    ...(env === undefined ? {} : { env }),
    ...(nullableNumber(row.timeout_ms) === undefined
      ? {}
      : { timeoutMs: nullableNumber(row.timeout_ms) }),
    ...(numberValue(row.events_enabled) === undefined
      ? {}
      : { events: numberValue(row.events_enabled) === 1 }),
    ...(numberValue(row.timed_out) === 1 ? { timedOut: true } : {}),
    pid: nullableNumber(row.pid),
    status: String(row.status) as BackgroundJobStatus,
    createdAt: Number(row.created_at),
    settledAt: nullableNumber(row.settled_at),
    exitCode: nullableNumber(row.exit_code),
    signal: textValue(row.signal),
    error: textValue(row.error),
    completionDelivered: row.completion_delivered === 1,
    stdout: {
      text: String(row.stdout_text ?? ''),
      totalBytes: Number(row.stdout_total ?? 0),
      droppedBytes: Number(row.stdout_dropped ?? 0),
    },
    stderr: {
      text: String(row.stderr_text ?? ''),
      totalBytes: Number(row.stderr_total ?? 0),
      droppedBytes: Number(row.stderr_dropped ?? 0),
    },
    fingerprint: String(row.fingerprint),
  };
}

/** Durable execution metadata; the database is never used to adopt a PID. */
export class BackgroundJobStore {
  readonly db: DatabaseSync;
  constructor(
    readonly databasePath: string,
    private readonly maxSettled = 32,
  ) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS background_jobs (
        id TEXT PRIMARY KEY,
        owner_session TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        title TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        env_json TEXT,
        timeout_ms INTEGER,
        events_enabled INTEGER,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        pid INTEGER,
        exit_code INTEGER,
        signal TEXT,
        error TEXT,
        timed_out INTEGER NOT NULL DEFAULT 0,
        completion_delivered INTEGER NOT NULL DEFAULT 0,
        stdout_text TEXT NOT NULL DEFAULT '',
        stdout_total INTEGER NOT NULL DEFAULT 0,
        stdout_dropped INTEGER NOT NULL DEFAULT 0,
        stderr_text TEXT NOT NULL DEFAULT '',
        stderr_total INTEGER NOT NULL DEFAULT 0,
        stderr_dropped INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS background_jobs_owner_settled
        ON background_jobs(owner_session, settled_at);
    `);
    for (const statement of [
      'ALTER TABLE background_jobs ADD COLUMN completion_delivered INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE background_jobs ADD COLUMN env_json TEXT',
      'ALTER TABLE background_jobs ADD COLUMN timeout_ms INTEGER',
      'ALTER TABLE background_jobs ADD COLUMN events_enabled INTEGER',
      'ALTER TABLE background_jobs ADD COLUMN timed_out INTEGER NOT NULL DEFAULT 0',
    ]) {
      try {
        this.db.exec(statement);
      } catch {
        /* Existing databases already have this column. */
      }
    }
    mkdirSync(backgroundJobEventsDirectory(databasePath), {
      recursive: true,
      mode: 0o700,
    });
    this.protectFiles();
    this.reconcileStaleActive();
    this.protectFiles();
  }

  private protectFiles(): void {
    try {
      chmodSync(path.dirname(this.databasePath), 0o700);
    } catch {
      return;
    }
    try {
      chmodSync(backgroundJobEventsDirectory(this.databasePath), 0o700);
    } catch {
      /* Directory may not exist during initial SQLite setup. */
    }
    for (const file of [
      this.databasePath,
      `${this.databasePath}-wal`,
      `${this.databasePath}-shm`,
    ]) {
      try {
        chmodSync(file, 0o600);
      } catch {
        /* SQLite creates WAL/SHM lazily. */
      }
    }
  }

  close(): void {
    this.db.close();
  }

  eventPath(id: string): string {
    return backgroundJobEventsPath(this.databasePath, id);
  }

  appendEvent(
    id: string,
    stream: BackgroundJobEvent['stream'],
    text: string,
  ): void {
    const bounded = boundedUtf8(text, BACKGROUND_JOBS_MAX_EVENT_LINE_BYTES);
    const file = this.eventPath(id);
    mkdirSync(backgroundJobEventsDirectory(this.databasePath), {
      recursive: true,
      mode: 0o700,
    });
    const current = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
    const offset = nextEventOffset(current);
    const encoded = Buffer.from(
      `${JSON.stringify({ offset, stream, text: bounded })}\n`,
      'utf8',
    );
    appendFileSync(file, encoded, { mode: 0o600 });
    chmodSync(file, 0o600);
    const complete = Buffer.concat([current, encoded]);
    if (complete.byteLength > BACKGROUND_JOBS_MAX_EVENT_BYTES) {
      const retained = retainEventBytes(
        complete,
        BACKGROUND_JOBS_MAX_EVENT_BYTES,
      );
      writeFileSync(file, retained, { mode: 0o600 });
      chmodSync(file, 0o600);
    }
  }

  readEvents(
    ownerSession: string,
    id: string,
    offset: number,
  ): BackgroundJobEventsSnapshot {
    const row = this.get(ownerSession, id);
    if (!row) throw new Error(`Unknown background job "${id}".`);
    const file = this.eventPath(id);
    const bytes = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
    const records = parseEventRecords(bytes);
    const firstOffset = records[0]?.event.offset ?? nextEventOffset(bytes);
    const truncated = offset < firstOffset;
    let nextOffset = Math.max(offset, firstOffset);
    const events: BackgroundJobEvent[] = [];
    for (const record of records) {
      if (record.event.offset < nextOffset) continue;
      const candidate = [...events, record.event];
      const encoded = Buffer.byteLength(
        JSON.stringify({
          events: candidate,
          truncated,
          complete: false,
          nextOffset: record.endOffset,
        }),
      );
      if (
        encoded > BACKGROUND_JOBS_MAX_EVENT_RESPONSE_BYTES &&
        events.length > 0
      )
        break;
      if (encoded > BACKGROUND_JOBS_MAX_EVENT_RESPONSE_BYTES) break;
      events.push(record.event);
      nextOffset = record.endOffset;
    }
    const endOffset = nextEventOffset(bytes);
    const complete =
      row.status !== 'running' &&
      nextOffset >= endOffset &&
      events.length ===
        records.filter(
          (record) => record.event.offset >= Math.max(offset, firstOffset),
        ).length;
    return { events, truncated, complete, nextOffset };
  }

  reconcileStaleActive(now = Date.now()): number {
    const result = this.db
      .prepare(`
      UPDATE background_jobs
      SET status = 'failed', settled_at = ?, error = ?, pid = NULL
      WHERE status = 'running'
    `)
      .run(now, HOST_RESTART_ERROR);
    for (const row of this.db
      .prepare('SELECT DISTINCT owner_session FROM background_jobs')
      .all()) {
      const ownerSession = textValue(row.owner_session);
      if (ownerSession) this.prune(ownerSession);
    }
    return Number(result.changes);
  }

  get(ownerSession: string, id: string): BackgroundJobStoreRow | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM background_jobs WHERE id = ? AND owner_session = ?',
      )
      .get(id, ownerSession);
    return row ? snapshot(row) : undefined;
  }

  getById(id: string): BackgroundJobStoreRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM background_jobs WHERE id = ?')
      .get(id);
    return row ? snapshot(row) : undefined;
  }

  list(ownerSession: string): BackgroundJobStoreRow[] {
    return this.db
      .prepare(`
      SELECT * FROM background_jobs WHERE owner_session = ?
      ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, created_at DESC
    `)
      .all(ownerSession)
      .map(snapshot);
  }

  activeCount(ownerSession: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM background_jobs WHERE owner_session = ? AND status = 'running'",
      )
      .get(ownerSession);
    return Number(row?.count ?? 0);
  }

  create(
    input: StartBackgroundJobInput,
    fingerprint: string,
    createdAt = Date.now(),
  ): BackgroundJobStoreRow {
    const existing = this.getById(input.id);
    if (existing) {
      if (
        existing.ownerSession !== input.ownerSession ||
        existing.fingerprint !== fingerprint
      )
        throw Object.assign(
          new Error('Job ID is already owned by a different launch.'),
          { code: 'job-conflict' },
        );
      return existing;
    }
    this.db
      .prepare(`
      INSERT INTO background_jobs
        (id, owner_session, fingerprint, title, command, cwd, env_json, timeout_ms, events_enabled, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
    `)
      .run(
        input.id,
        input.ownerSession,
        fingerprint,
        input.title,
        input.command,
        input.cwd,
        input.env === undefined ? null : JSON.stringify(input.env),
        input.timeoutMs ?? null,
        input.events === undefined ? null : input.events ? 1 : 0,
        createdAt,
      );
    this.protectFiles();
    return this.get(input.ownerSession, input.id) as BackgroundJobStoreRow;
  }

  setPid(id: string, pid: number): void {
    this.db
      .prepare(
        "UPDATE background_jobs SET pid = ? WHERE id = ? AND status = 'running'",
      )
      .run(pid, id);
    this.protectFiles();
  }

  setOutput(id: string, stdout: OutputSnapshot, stderr: OutputSnapshot): void {
    this.db
      .prepare(`
      UPDATE background_jobs
      SET stdout_text = ?, stdout_total = ?, stdout_dropped = ?,
          stderr_text = ?, stderr_total = ?, stderr_dropped = ?
      WHERE id = ? AND status = 'running'
    `)
      .run(
        stdout.text,
        stdout.totalBytes,
        stdout.droppedBytes,
        stderr.text,
        stderr.totalBytes,
        stderr.droppedBytes,
        id,
      );
    this.protectFiles();
  }

  settle(
    id: string,
    status: Exclude<BackgroundJobStatus, 'running'>,
    details: {
      exitCode?: number;
      signal?: string;
      error?: string;
      timedOut?: boolean;
    },
    stdout: OutputSnapshot,
    stderr: OutputSnapshot,
    settledAt = Date.now(),
  ): BackgroundJobStoreRow | undefined {
    this.db
      .prepare(`
      UPDATE background_jobs
      SET status = ?, settled_at = ?, exit_code = ?, signal = ?, error = ?, timed_out = ?, completion_delivered = 0,
          stdout_text = ?, stdout_total = ?, stdout_dropped = ?,
          stderr_text = ?, stderr_total = ?, stderr_dropped = ?
      WHERE id = ? AND status = 'running'
    `)
      .run(
        status,
        settledAt,
        details.exitCode ?? null,
        details.signal ?? null,
        details.error ?? null,
        details.timedOut ? 1 : 0,
        stdout.text,
        stdout.totalBytes,
        stdout.droppedBytes,
        stderr.text,
        stderr.totalBytes,
        stderr.droppedBytes,
        id,
      );
    const row = this.getById(id);
    if (row) this.prune(row.ownerSession);
    this.protectFiles();
    return row;
  }

  markDelivered(ownerSession: string, id: string): void {
    this.db
      .prepare(
        "UPDATE background_jobs SET completion_delivered = 1 WHERE owner_session = ? AND id = ? AND status <> 'running'",
      )
      .run(ownerSession, id);
    this.protectFiles();
  }

  prune(ownerSession: string): void {
    const removed = this.db
      .prepare(`
      SELECT id FROM background_jobs
      WHERE owner_session = ? AND status <> 'running' AND id NOT IN (
        SELECT id FROM background_jobs
        WHERE owner_session = ? AND status <> 'running'
        ORDER BY settled_at DESC, created_at DESC LIMIT ?
      )
    `)
      .all(ownerSession, ownerSession, this.maxSettled);
    this.db
      .prepare(`
      DELETE FROM background_jobs
      WHERE owner_session = ? AND status <> 'running' AND id NOT IN (
        SELECT id FROM background_jobs
        WHERE owner_session = ? AND status <> 'running'
        ORDER BY settled_at DESC, created_at DESC LIMIT ?
      )
    `)
      .run(ownerSession, ownerSession, this.maxSettled);
    for (const row of removed) {
      const id = textValue(row.id);
      if (id) {
        try {
          unlinkSync(this.eventPath(id));
        } catch {
          /* The event file may not have been created. */
        }
      }
    }
    this.protectFiles();
  }
}

export { HOST_RESTART_ERROR };
