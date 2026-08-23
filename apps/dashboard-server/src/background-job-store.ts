import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
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
  BACKGROUND_JOBS_MAX_EVENT_RECORD_BYTES,
  BACKGROUND_JOBS_MAX_EVENT_RESPONSE_BYTES,
  backgroundJobsLaunchFingerprint,
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
type EventWriteState = { bytes: number; nextOffset: number };

function parseEventRecords(bytes: Buffer): StoredEvent[] {
  const records: StoredEvent[] = [];
  let start = 0;
  let expectedOffset: number | undefined;
  while (start < bytes.byteLength) {
    const newline = bytes.indexOf(0x0a, start);
    if (newline < 0) throw new Error('Corrupt background job event file.');
    const lineBytes = newline + 1 - start;
    if (lineBytes > BACKGROUND_JOBS_MAX_EVENT_RECORD_BYTES)
      throw new Error('Corrupt background job event file.');
    let parsed: {
      offset?: unknown;
      stream?: unknown;
      text?: unknown;
      truncated?: unknown;
    };
    try {
      parsed = JSON.parse(
        bytes.subarray(start, newline).toString('utf8'),
      ) as typeof parsed;
    } catch {
      throw new Error('Corrupt background job event file.');
    }
    if (
      typeof parsed.offset !== 'number' ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0 ||
      (expectedOffset !== undefined && parsed.offset !== expectedOffset) ||
      (parsed.stream !== 'stdout' && parsed.stream !== 'stderr') ||
      typeof parsed.text !== 'string' ||
      Buffer.byteLength(parsed.text) > BACKGROUND_JOBS_MAX_EVENT_LINE_BYTES ||
      typeof parsed.truncated !== 'boolean'
    )
      throw new Error('Corrupt background job event file.');
    if (parsed.offset > Number.MAX_SAFE_INTEGER - lineBytes)
      throw new Error('Corrupt background job event file.');
    const endOffset = parsed.offset + lineBytes;
    records.push({
      event: {
        offset: parsed.offset,
        stream: parsed.stream,
        text: parsed.text,
        truncated: parsed.truncated,
      },
      endOffset,
    });
    expectedOffset = endOffset;
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

function encodeEvent(
  offset: number,
  stream: BackgroundJobEvent['stream'],
  text: string,
  truncated: boolean,
): Buffer {
  return Buffer.from(
    `${JSON.stringify({ offset, stream, text, truncated })}\n`,
    'utf8',
  );
}

function boundedEvent(
  offset: number,
  stream: BackgroundJobEvent['stream'],
  text: string,
  truncated: boolean,
): { text: string; truncated: boolean; encoded: Buffer } {
  let encoded = encodeEvent(offset, stream, text, truncated);
  if (encoded.byteLength <= BACKGROUND_JOBS_MAX_EVENT_RECORD_BYTES)
    return { text, truncated, encoded };
  const bytes = Buffer.from(text);
  let low = 0;
  let high = bytes.byteLength;
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = boundedUtf8(text, middle);
    const candidateEncoded = encodeEvent(offset, stream, candidate, true);
    if (candidateEncoded.byteLength <= BACKGROUND_JOBS_MAX_EVENT_RECORD_BYTES) {
      best = candidate;
      encoded = candidateEncoded;
      low = middle + 1;
    } else high = middle - 1;
  }
  return { text: best, truncated: true, encoded };
}

function readBoundedEventFile(file: string): Buffer {
  const info = statSync(file);
  if (!Number.isSafeInteger(info.size))
    throw new Error('Background job event file is too large.');
  if (info.size <= BACKGROUND_JOBS_MAX_EVENT_BYTES) return readFileSync(file);
  const window = Math.min(
    info.size,
    BACKGROUND_JOBS_MAX_EVENT_BYTES + BACKGROUND_JOBS_MAX_EVENT_RECORD_BYTES,
  );
  const start = info.size - window;
  const fd = openSync(file, 'r');
  const bytes = Buffer.alloc(window);
  let count = 0;
  try {
    count = readSync(fd, bytes, 0, window, start);
  } finally {
    closeSync(fd);
  }
  const retained = retainEventBytes(
    bytes.subarray(0, count),
    BACKGROUND_JOBS_MAX_EVENT_BYTES,
  );
  writeFileSync(file, retained, { mode: 0o600 });
  chmodSync(file, 0o600);
  return retained;
}

function snapshot(row: Record<string, unknown>): BackgroundJobStoreRow {
  return {
    id: String(row.id),
    ownerSession: String(row.owner_session),
    title: String(row.title),
    command: String(row.command),
    cwd: String(row.cwd),
    ...(nullableNumber(row.timeout_ms) === undefined
      ? {}
      : { timeoutMs: nullableNumber(row.timeout_ms) }),
    ...(numberValue(row.events_enabled) === undefined
      ? {}
      : { events: numberValue(row.events_enabled) === 1 }),
    ...(numberValue(row.exact_env) === undefined
      ? {}
      : { exactEnv: numberValue(row.exact_env) === 1 }),
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
  private readonly eventWrites = new Map<string, EventWriteState>();
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
        timeout_ms INTEGER,
        events_enabled INTEGER,
        exact_env INTEGER NOT NULL DEFAULT 0,
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
      'ALTER TABLE background_jobs ADD COLUMN timeout_ms INTEGER',
      'ALTER TABLE background_jobs ADD COLUMN events_enabled INTEGER',
      'ALTER TABLE background_jobs ADD COLUMN exact_env INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE background_jobs ADD COLUMN timed_out INTEGER NOT NULL DEFAULT 0',
    ]) {
      try {
        this.db.exec(statement);
      } catch {
        /* Existing databases already have this column. */
      }
    }
    const hadEnvColumn = this.hasEnvColumn();
    try {
      this.db.exec('ALTER TABLE background_jobs DROP COLUMN env_json');
    } catch {
      /* New databases and already-migrated databases have no such column. */
    }
    if (this.hasEnvColumn()) {
      this.db.close();
      throw new Error('Background job store still contains env_json.');
    }
    const migratedFingerprints = this.migrateFingerprints();
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    if (hadEnvColumn || migratedFingerprints) {
      this.db.exec('VACUUM');
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
    mkdirSync(backgroundJobEventsDirectory(databasePath), {
      recursive: true,
      mode: 0o700,
    });
    this.repairEventFiles();
    this.protectFiles();
    this.reconcileStaleActive();
    this.protectFiles();
  }

  private hasEnvColumn(): boolean {
    return this.db
      .prepare('PRAGMA table_info(background_jobs)')
      .all()
      .some((column) => column.name === 'env_json');
  }

  private migrateFingerprints(): boolean {
    let migrated = false;
    const rows = this.db
      .prepare('SELECT id, fingerprint FROM background_jobs')
      .all();
    for (const row of rows) {
      const current = textValue(row.fingerprint);
      if (current && /^[0-9a-f]{64}$/u.test(current)) continue;
      if (!current) throw new Error('Background job fingerprint is missing.');
      let value: unknown;
      try {
        value = JSON.parse(current);
      } catch {
        throw new Error('Background job fingerprint cannot be migrated.');
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Background job fingerprint cannot be migrated.');
      const launch = value as Record<string, unknown>;
      if (
        typeof launch.command !== 'string' ||
        typeof launch.title !== 'string' ||
        typeof launch.cwd !== 'string'
      )
        throw new Error('Background job fingerprint cannot be migrated.');
      if (
        launch.argv !== undefined &&
        (!Array.isArray(launch.argv) ||
          launch.argv.some((item) => typeof item !== 'string'))
      )
        throw new Error('Background job fingerprint cannot be migrated.');
      let env: Record<string, string> | undefined;
      if (launch.env !== undefined) {
        if (
          !launch.env ||
          typeof launch.env !== 'object' ||
          Array.isArray(launch.env)
        )
          throw new Error('Background job fingerprint cannot be migrated.');
        env = {};
        const legacyEnv = launch.env as Record<string, unknown>;
        for (const key of Object.keys(legacyEnv).sort()) {
          const item = legacyEnv[key];
          if (typeof item !== 'string')
            throw new Error('Background job fingerprint cannot be migrated.');
          env[key] = item;
        }
      }
      if (
        launch.timeoutMs !== undefined &&
        (typeof launch.timeoutMs !== 'number' ||
          !Number.isSafeInteger(launch.timeoutMs) ||
          launch.timeoutMs < 0)
      )
        throw new Error('Background job fingerprint cannot be migrated.');
      if (launch.events !== undefined && typeof launch.events !== 'boolean')
        throw new Error('Background job fingerprint cannot be migrated.');
      if (launch.exactEnv !== undefined && typeof launch.exactEnv !== 'boolean')
        throw new Error('Background job fingerprint cannot be migrated.');
      const hash = backgroundJobsLaunchFingerprint({
        command: launch.command,
        title: launch.title,
        cwd: launch.cwd,
        ...(launch.argv === undefined ? {} : { argv: launch.argv }),
        ...(env === undefined ? {} : { env }),
        ...(launch.timeoutMs === undefined
          ? {}
          : { timeoutMs: launch.timeoutMs }),
        ...(launch.events === undefined ? {} : { events: launch.events }),
        ...(launch.exactEnv === true ? { exactEnv: true } : {}),
      });
      this.db
        .prepare('UPDATE background_jobs SET fingerprint = ? WHERE id = ?')
        .run(hash, row.id);
      migrated = true;
    }
    return migrated;
  }

  private repairEventFiles(): void {
    const known = new Set(
      this.db
        .prepare('SELECT id FROM background_jobs')
        .all()
        .map((row) => textValue(row.id))
        .filter((id): id is string => id !== undefined),
    );
    const directory = backgroundJobEventsDirectory(this.databasePath);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const id = entry.name.slice(0, -'.jsonl'.length);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          id,
        )
      )
        continue;
      const file = path.join(directory, entry.name);
      if (!known.has(id)) {
        unlinkSync(file);
        continue;
      }
      chmodSync(file, 0o600);
      if (statSync(file).size > BACKGROUND_JOBS_MAX_EVENT_BYTES)
        readBoundedEventFile(file);
    }
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
    this.eventWrites.clear();
    this.db.close();
  }

  eventPath(id: string): string {
    return backgroundJobEventsPath(this.databasePath, id);
  }

  appendEvent(
    id: string,
    stream: BackgroundJobEvent['stream'],
    text: string,
    truncated = false,
  ): void {
    const bounded = boundedUtf8(text, BACKGROUND_JOBS_MAX_EVENT_LINE_BYTES);
    const file = this.eventPath(id);
    mkdirSync(backgroundJobEventsDirectory(this.databasePath), {
      recursive: true,
      mode: 0o700,
    });
    let state = this.eventWrites.get(id);
    if (!state) {
      const current = existsSync(file)
        ? readBoundedEventFile(file)
        : Buffer.alloc(0);
      state = {
        bytes: current.byteLength,
        nextOffset: nextEventOffset(current),
      };
      this.eventWrites.set(id, state);
    }
    const event = boundedEvent(state.nextOffset, stream, bounded, truncated);
    const encoded = event.encoded;
    if (state.nextOffset > Number.MAX_SAFE_INTEGER - encoded.byteLength)
      throw new Error('Background job event offset exceeded its bound.');
    appendFileSync(file, encoded, { mode: 0o600 });
    chmodSync(file, 0o600);
    state.bytes += encoded.byteLength;
    state.nextOffset += encoded.byteLength;
    if (state.bytes > BACKGROUND_JOBS_MAX_EVENT_BYTES) {
      const complete = readBoundedEventFile(file);
      const retained = retainEventBytes(
        complete,
        Math.floor(BACKGROUND_JOBS_MAX_EVENT_BYTES / 2),
      );
      writeFileSync(file, retained, { mode: 0o600 });
      chmodSync(file, 0o600);
      state.bytes = retained.byteLength;
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
    const bytes = existsSync(file)
      ? readBoundedEventFile(file)
      : Buffer.alloc(0);
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
    _fingerprint: string,
    createdAt = Date.now(),
  ): BackgroundJobStoreRow {
    const fingerprint = backgroundJobsLaunchFingerprint(input);
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
    this.eventWrites.delete(input.id);
    try {
      unlinkSync(this.eventPath(input.id));
    } catch {
      /* A pruned row may leave no event file. */
    }
    this.db
      .prepare(`
      INSERT INTO background_jobs
        (id, owner_session, fingerprint, title, command, cwd, timeout_ms, events_enabled, exact_env, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
    `)
      .run(
        input.id,
        input.ownerSession,
        fingerprint,
        input.title,
        input.command,
        input.cwd,
        input.timeoutMs ?? null,
        input.events === undefined ? null : input.events ? 1 : 0,
        input.exactEnv ? 1 : 0,
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
    this.eventWrites.delete(id);
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
