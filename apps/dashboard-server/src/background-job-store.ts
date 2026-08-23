import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  BackgroundJobSnapshot,
  BackgroundJobStatus,
  OutputSnapshot,
  StartBackgroundJobInput,
} from '@pi-agent/background-jobs';

const HOST_RESTART_ERROR =
  'Background job was marked failed because the process host restarted; the process was not adopted by PID.';

export interface BackgroundJobStoreRow extends BackgroundJobSnapshot {
  readonly fingerprint: string;
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
function snapshot(row: Record<string, unknown>): BackgroundJobStoreRow {
  return {
    id: String(row.id),
    ownerSession: String(row.owner_session),
    title: String(row.title),
    command: String(row.command),
    cwd: String(row.cwd),
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
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        pid INTEGER,
        exit_code INTEGER,
        signal TEXT,
        error TEXT,
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
    try {
      this.db.exec(
        'ALTER TABLE background_jobs ADD COLUMN completion_delivered INTEGER NOT NULL DEFAULT 0',
      );
    } catch {
      /* Existing databases already have the phase-1 column. */
    }
    this.protectFiles();
    this.reconcileStaleActive();
    this.protectFiles();
  }

  private protectFiles(): void {
    chmodSync(path.dirname(this.databasePath), 0o700);
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
        (id, owner_session, fingerprint, title, command, cwd, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
    `)
      .run(
        input.id,
        input.ownerSession,
        fingerprint,
        input.title,
        input.command,
        input.cwd,
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
    details: { exitCode?: number; signal?: string; error?: string },
    stdout: OutputSnapshot,
    stderr: OutputSnapshot,
    settledAt = Date.now(),
  ): BackgroundJobStoreRow | undefined {
    this.db
      .prepare(`
      UPDATE background_jobs
      SET status = ?, settled_at = ?, exit_code = ?, signal = ?, error = ?, completion_delivered = 0,
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
    this.protectFiles();
  }
}

export { HOST_RESTART_ERROR };
