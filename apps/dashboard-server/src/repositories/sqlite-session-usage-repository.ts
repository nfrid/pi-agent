import type { DatabaseSync } from 'node:sqlite';
import type { UsageSpendSeries } from '@pi-dashboard/protocol';

export interface SessionUsageEvent {
  eventKey: string;
  occurredAt: number;
  provider: string;
  modelId: string;
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface SessionUsageSource {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  fingerprint: string;
}

type Row = Record<string, unknown>;

export class SqliteSessionUsageRepository {
  constructor(private readonly db: DatabaseSync) {}

  source(path: string): SessionUsageSource | undefined {
    const row = this.db
      .prepare(
        'SELECT path,size,mtime_ms,ctime_ms,fingerprint FROM session_usage_source WHERE path=?',
      )
      .get(path) as Row | undefined;
    return row
      ? {
          path: String(row.path),
          size: Number(row.size),
          mtimeMs: Number(row.mtime_ms),
          ctimeMs: Number(row.ctime_ms),
          fingerprint: String(row.fingerprint),
        }
      : undefined;
  }

  reconcileSources(paths: readonly string[]): void {
    const current = new Set(paths);
    const existing = this.db
      .prepare('SELECT path FROM session_usage_source')
      .all() as Row[];
    const stale = existing
      .map((row) => String(row.path))
      .filter((sourcePath) => !current.has(sourcePath));
    if (stale.length === 0) return;
    const sourceEvents = this.db.prepare(
      'SELECT event_key FROM session_usage_source_event WHERE source_path=?',
    );
    const removeSource = this.db.prepare(
      'DELETE FROM session_usage_source WHERE path=?',
    );
    const removeOrphan = this.db.prepare(`
      DELETE FROM session_usage_event
      WHERE event_key=? AND NOT EXISTS (
        SELECT 1 FROM session_usage_source_event source
        WHERE source.event_key=?
      )
    `);
    this.db.exec('SAVEPOINT session_usage_reconcile');
    try {
      for (const sourcePath of stale) {
        const events = sourceEvents.all(sourcePath) as Row[];
        removeSource.run(sourcePath);
        for (const event of events) {
          const eventKey = String(event.event_key);
          removeOrphan.run(eventKey, eventKey);
        }
      }
      this.db.exec('RELEASE SAVEPOINT session_usage_reconcile');
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT session_usage_reconcile');
      this.db.exec('RELEASE SAVEPOINT session_usage_reconcile');
      throw error;
    }
  }

  appendFile(
    source: SessionUsageSource,
    events: readonly SessionUsageEvent[],
    indexedAt = Date.now(),
  ): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO session_usage_event
        (event_key,occurred_at,provider,model_id,label,calls,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_usd)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const saveSource = this.db.prepare(`
      INSERT INTO session_usage_source (path,size,mtime_ms,ctime_ms,fingerprint,indexed_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET
        size=excluded.size,
        mtime_ms=excluded.mtime_ms,
        ctime_ms=excluded.ctime_ms,
        fingerprint=excluded.fingerprint,
        indexed_at=excluded.indexed_at
    `);
    const sourceEvents = this.db.prepare(
      'SELECT event_key FROM session_usage_source_event WHERE source_path=?',
    );
    const removeSourceEvents = this.db.prepare(
      'DELETE FROM session_usage_source_event WHERE source_path=?',
    );
    const linkEvent = this.db.prepare(`
      INSERT OR IGNORE INTO session_usage_source_event (source_path,event_key)
      VALUES (?,?)
    `);
    const removeOrphan = this.db.prepare(`
      DELETE FROM session_usage_event
      WHERE event_key=? AND NOT EXISTS (
        SELECT 1 FROM session_usage_source_event source
        WHERE source.event_key=?
      )
    `);
    this.db.exec('SAVEPOINT session_usage_append');
    try {
      const previousEvents = sourceEvents.all(source.path) as Row[];
      saveSource.run(
        source.path,
        source.size,
        source.mtimeMs,
        source.ctimeMs,
        source.fingerprint,
        indexedAt,
      );
      removeSourceEvents.run(source.path);
      for (const event of events) {
        insert.run(
          event.eventKey,
          event.occurredAt,
          event.provider,
          event.modelId,
          event.label,
          event.calls,
          event.inputTokens,
          event.outputTokens,
          event.cacheReadTokens,
          event.cacheWriteTokens,
          event.totalTokens,
          event.costUsd,
        );
        linkEvent.run(source.path, event.eventKey);
      }
      for (const previous of previousEvents) {
        const eventKey = String(previous.event_key);
        removeOrphan.run(eventKey, eventKey);
      }
      this.db.exec('RELEASE SAVEPOINT session_usage_append');
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT session_usage_append');
      this.db.exec('RELEASE SAVEPOINT session_usage_append');
      throw error;
    }
  }

  read(
    periodStart: number,
    periodEnd: number,
    bucketMs: number,
  ): UsageSpendSeries[] {
    const identities = this.db
      .prepare(
        `SELECT provider,model_id,SUM(cost_usd) AS cost,SUM(total_tokens) AS tokens
         FROM session_usage_event
         WHERE occurred_at>=? AND occurred_at<?
         GROUP BY provider,model_id
         HAVING cost>0 OR tokens>0
         ORDER BY cost DESC,tokens DESC,provider,model_id
         LIMIT 64`,
      )
      .all(periodStart, periodEnd) as Row[];
    const points = this.db.prepare(`
      SELECT
        CAST((occurred_at-?)/? AS INTEGER) AS bucket_index,
        MAX(label) AS label,
        SUM(calls) AS calls,
        SUM(cost_usd) AS cost_usd,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_write_tokens) AS cache_write_tokens,
        SUM(total_tokens) AS total_tokens
      FROM session_usage_event
      WHERE provider=? AND model_id=? AND occurred_at>=? AND occurred_at<?
      GROUP BY bucket_index
      ORDER BY bucket_index
    `);
    return identities.flatMap((identity) => {
      const provider = String(identity.provider);
      const modelId = String(identity.model_id);
      const rows = points.all(
        periodStart,
        bucketMs,
        provider,
        modelId,
        periodStart,
        periodEnd,
      ) as Row[];
      const first = rows[0];
      if (!first) return [];
      return [
        {
          id: `${provider}:${modelId}`,
          provider,
          modelId,
          label: String(first.label),
          points: rows.map((row) => ({
            bucketStart: periodStart + Number(row.bucket_index) * bucketMs,
            calls: Number(row.calls),
            costUsd: Number(row.cost_usd),
            inputTokens: Number(row.input_tokens),
            outputTokens: Number(row.output_tokens),
            cacheReadTokens: Number(row.cache_read_tokens),
            cacheWriteTokens: Number(row.cache_write_tokens),
            totalTokens: Number(row.total_tokens),
          })),
        },
      ];
    });
  }
}
