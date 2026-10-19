import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  isSafeTelemetryErrorName,
  redactTelemetryNote,
  TELEMETRY_MAX_EVENTS,
  TELEMETRY_RETENTION_DAYS,
  type TelemetryEvent,
  type TelemetryIssue,
  type TelemetryOverview,
  type TelemetrySample,
} from './contracts.js';

export * from './contracts.js';

const tokenPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;
const sources = new Set(['harness', 'dashboard-server', 'dashboard-browser']);
const outcomes = new Set(['success', 'failure', 'expected', 'quirk']);
let revision: string | undefined;
export function telemetryVersion(runtimeVersion: string): string {
  const override = process.env.PI_TELEMETRY_VERSION;
  if (override && tokenPattern.test(override)) return override;
  if (revision === undefined) {
    try {
      revision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        timeout: 500,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      revision = 'unknown';
    }
  }
  return `pi-${runtimeVersion}.${revision}`;
}

/** PI_TELEMETRY_DIR can isolate tests or move the local store. No remote sink. */
export function defaultTelemetryDirectory(): string {
  return process.env.PI_TELEMETRY_DIR ?? join(getAgentDir(), 'telemetry');
}

function normalize(event: TelemetryEvent): TelemetryEvent | undefined {
  if (
    !sources.has(event.source) ||
    !outcomes.has(event.outcome) ||
    typeof event.operation !== 'string' ||
    !tokenPattern.test(event.operation) ||
    typeof event.code !== 'string' ||
    !tokenPattern.test(event.code) ||
    typeof event.version !== 'string' ||
    !tokenPattern.test(event.version)
  )
    return undefined;
  const optionalId = (value: string | undefined) =>
    typeof value === 'string' && tokenPattern.test(value) ? value : undefined;
  const note =
    event.outcome === 'quirk' && typeof event.note === 'string'
      ? redactTelemetryNote(event.note)
      : undefined;
  if (event.outcome === 'quirk' && !note) return undefined;
  return {
    source: event.source,
    operation: event.operation,
    code: event.code,
    outcome: event.outcome,
    version: event.version,
    ...(typeof event.durationMs === 'number' &&
    Number.isFinite(event.durationMs) &&
    event.durationMs >= 0
      ? { durationMs: Math.min(Math.round(event.durationMs), 86_400_000) }
      : {}),
    ...(optionalId(event.sessionId)
      ? { sessionId: optionalId(event.sessionId) }
      : {}),
    ...(optionalId(event.attemptId)
      ? { attemptId: optionalId(event.attemptId) }
      : {}),
    ...(isSafeTelemetryErrorName(event.errorName)
      ? { errorName: event.errorName }
      : {}),
    ...(note ? { note } : {}),
  };
}

const emptyOverview = (): TelemetryOverview => ({
  available: false,
  retentionDays: TELEMETRY_RETENTION_DAYS,
  maxEvents: TELEMETRY_MAX_EVENTS,
  eventCount: 0,
  observationCount: 0,
  firstTimestamp: null,
  lastTimestamp: null,
  issues: [],
});

/** Small synchronous writes, capped busy wait, and no exceptions to callers. */
export class TelemetryStore {
  private db?: DatabaseSync;
  constructor(
    readonly directory = defaultTelemetryDirectory(),
    private readonly now: () => number = Date.now,
  ) {}

  private database(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const file = join(this.directory, 'events.sqlite');
    const db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      db.exec(`
        PRAGMA busy_timeout = 25;
        PRAGMA journal_mode = DELETE;
        PRAGMA max_page_count = 8192;
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          source TEXT NOT NULL, operation TEXT NOT NULL, code TEXT NOT NULL,
          outcome TEXT NOT NULL, payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_timestamp ON events(timestamp);
      `);
      const columns = new Set(
        (
          db.prepare('PRAGMA table_info(events)').all() as { name: string }[]
        ).map((column) => column.name),
      );
      if (!columns.has('occurrence_count'))
        db.exec(
          'ALTER TABLE events ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1',
        );
      if (!columns.has('aggregate_bucket'))
        db.exec('ALTER TABLE events ADD COLUMN aggregate_bucket INTEGER');
      if (!columns.has('last_timestamp')) {
        db.exec('ALTER TABLE events ADD COLUMN last_timestamp INTEGER');
        db.exec('UPDATE events SET last_timestamp = timestamp');
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS events_aggregate_bucket
        ON events(source, operation, code, payload, aggregate_bucket)
        WHERE aggregate_bucket IS NOT NULL`);
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private prune(db: DatabaseSync, reserve = 0): void {
    db.prepare('DELETE FROM events WHERE timestamp < ?').run(
      this.now() - TELEMETRY_RETENTION_DAYS * 86_400_000,
    );
    db.prepare(`DELETE FROM events WHERE id IN (
      SELECT id FROM events ORDER BY id DESC LIMIT -1 OFFSET ?
    )`).run(TELEMETRY_MAX_EVENTS - reserve);
  }

  record(event: TelemetryEvent): boolean {
    let db: DatabaseSync | undefined;
    try {
      const value = normalize(event);
      if (!value) return false;
      db = this.database();
      db.exec('BEGIN IMMEDIATE');
      const aggregate =
        value.source === 'dashboard-server' &&
        value.outcome === 'success' &&
        value.code === 'http-200' &&
        (value.operation === 'http..api.settings' ||
          value.operation === 'http..api.sessions..id.delegate.history' ||
          value.operation === 'http..api.push.foreground');
      const now = this.now();
      const aggregateValue = aggregate
        ? {
            source: value.source,
            operation: value.operation,
            code: value.code,
            outcome: value.outcome,
            version: value.version,
          }
        : undefined;
      const bucket = aggregate
        ? Math.floor(now / 3_600_000) * 3_600_000
        : undefined;
      if (aggregate) {
        this.prune(db);
        const existing = db
          .prepare(`SELECT id FROM events WHERE source = ? AND operation = ?
            AND code = ? AND payload = ? AND aggregate_bucket = ?`)
          .get(
            value.source,
            value.operation,
            value.code,
            JSON.stringify(aggregateValue),
            bucket ?? null,
          ) as { id: number } | undefined;
        if (existing) {
          db.prepare(`UPDATE events SET occurrence_count = occurrence_count + 1,
            last_timestamp = ? WHERE id = ?`).run(now, existing.id);
          db.exec('COMMIT');
          return true;
        }
      }
      this.prune(db, 1);
      const relatedEventIds =
        value.outcome === 'quirk'
          ? db
              .prepare(`
        SELECT id FROM events WHERE outcome <> 'quirk'
        AND (? IS NULL OR json_extract(payload, '$.sessionId') = ?)
        ORDER BY id DESC LIMIT 10
      `)
              .all(value.sessionId ?? null, value.sessionId ?? null)
              .map((row) => Number(row.id))
          : undefined;
      db.prepare(`INSERT INTO events(timestamp, source, operation, code, outcome, payload,
        occurrence_count, aggregate_bucket, last_timestamp)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
        now,
        value.source,
        value.operation,
        value.code,
        value.outcome,
        JSON.stringify({
          ...(aggregateValue ?? value),
          ...(relatedEventIds ? { relatedEventIds } : {}),
        }),
        bucket ?? null,
        now,
      );
      db.exec('COMMIT');
      return true;
    } catch {
      try {
        db?.exec('ROLLBACK');
      } catch {
        /* A busy writer may never begin. */
      }
      return false;
    }
  }

  overview(): TelemetryOverview {
    try {
      const db = this.database();
      this.prune(db);
      const rows = db
        .prepare(
          `SELECT id, timestamp, COALESCE(last_timestamp, timestamp) AS last_timestamp,
            payload, occurrence_count FROM events ORDER BY id DESC`,
        )
        .all() as unknown as {
        id: number;
        timestamp: number;
        last_timestamp: number;
        payload: string;
        occurrence_count: number;
      }[];
      const parsed = rows.map((row) => ({
        ...row,
        event: JSON.parse(row.payload) as TelemetryEvent & {
          relatedEventIds?: number[];
        },
      }));
      const byId = new Map(parsed.map((row) => [row.id, row]));
      const totals = new Map<string, { attempts: number; failures: number }>();
      const groups = new Map<string, TelemetryIssue>();
      for (const row of parsed) {
        const { relatedEventIds, ...event } = row.event;
        const operationKey = JSON.stringify([event.source, event.operation]);
        if (event.outcome !== 'quirk') {
          const total = totals.get(operationKey) ?? {
            attempts: 0,
            failures: 0,
          };
          total.attempts += row.occurrence_count;
          if (event.outcome === 'failure')
            total.failures += row.occurrence_count;
          totals.set(operationKey, total);
        }
        if (event.outcome === 'success') continue;
        const key = JSON.stringify([
          event.source,
          event.operation,
          event.code,
          event.outcome,
        ]);
        let group = groups.get(key);
        if (!group) {
          group = {
            source: event.source,
            operation: event.operation,
            code: event.code,
            outcome: event.outcome,
            count: 0,
            attempts: 0,
            failures: 0,
            firstSeen: row.timestamp,
            lastSeen: row.timestamp,
            samples: [],
          };
          groups.set(key, group);
        }
        group.count += row.occurrence_count;
        group.firstSeen = Math.min(group.firstSeen, row.timestamp);
        group.lastSeen = Math.max(group.lastSeen, row.timestamp);
        if (group.samples.length < 5)
          group.samples.push({
            ...event,
            id: row.id,
            timestamp: row.timestamp,
            ...(relatedEventIds
              ? {
                  context: relatedEventIds.flatMap((id) => {
                    const related = byId.get(id);
                    return related
                      ? [
                          {
                            id,
                            timestamp: related.timestamp,
                            source: related.event.source,
                            operation: related.event.operation,
                            code: related.event.code,
                            outcome: related.event.outcome,
                            version: related.event.version,
                          },
                        ]
                      : [];
                  }),
                }
              : {}),
          } satisfies TelemetrySample);
      }
      const issues = [...groups.values()].sort(
        (a, b) => b.lastSeen - a.lastSeen,
      );
      for (const issue of issues) {
        const total = totals.get(
          JSON.stringify([issue.source, issue.operation]),
        );
        issue.attempts = total?.attempts ?? 0;
        issue.failures = total?.failures ?? 0;
      }
      return {
        available: true,
        retentionDays: TELEMETRY_RETENTION_DAYS,
        maxEvents: TELEMETRY_MAX_EVENTS,
        eventCount: rows.length,
        observationCount: rows.reduce(
          (count, row) => count + row.occurrence_count,
          0,
        ),
        firstTimestamp:
          rows.length > 0
            ? Math.min(...rows.map((row) => row.timestamp))
            : null,
        lastTimestamp:
          rows.length > 0
            ? Math.max(...rows.map((row) => row.last_timestamp))
            : null,
        issues: issues.slice(0, 100),
      };
    } catch {
      return emptyOverview();
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* Shutdown must remain best-effort. */
    }
    this.db = undefined;
  }
}

let defaultStore: TelemetryStore | undefined;
export function recordTelemetry(event: TelemetryEvent): boolean {
  defaultStore ??= new TelemetryStore();
  return defaultStore.record(event);
}
