import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  redactTelemetryNote,
  safeTelemetryErrorName,
  TELEMETRY_MAX_EVENTS,
  type TelemetryEvent,
  TelemetryStore,
} from './index.js';

const directories: string[] = [];
const stores: TelemetryStore[] = [];
function fixture(now: () => number = Date.now) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-telemetry-'));
  directories.push(directory);
  const store = new TelemetryStore(directory, now);
  stores.push(store);
  return { store, directory };
}
const event: TelemetryEvent = {
  source: 'harness',
  operation: 'delegate',
  code: 'timeout',
  outcome: 'failure',
  version: 'pi-1.0.0',
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('local telemetry', () => {
  it('persists and groups failures with operation attempt counts and version samples', () => {
    let now = 1_000;
    const { store, directory } = fixture(() => now);
    expect(
      store.record({ ...event, outcome: 'success', code: 'completed' }),
    ).toBe(true);
    expect(store.record(event)).toBe(true);
    now = 2_000;
    expect(store.record({ ...event, version: 'pi-1.0.1' })).toBe(true);
    expect(
      store.record({ ...event, code: 'cancelled', outcome: 'expected' }),
    ).toBe(true);
    store.close();
    const reopened = new TelemetryStore(directory, () => now);
    stores.push(reopened);
    const overview = reopened.overview();
    expect(overview.available).toBe(true);
    expect(overview.eventCount).toBe(4);
    expect(overview.observationCount).toBe(4);
    const issue = overview.issues.find((item) => item.code === 'timeout');
    expect(issue).toMatchObject({
      count: 2,
      attempts: 4,
      failures: 2,
      firstSeen: 1_000,
      lastSeen: 2_000,
    });
    expect(issue?.samples.map((sample) => sample.version)).toEqual([
      'pi-1.0.1',
      'pi-1.0.0',
    ]);
    expect(
      overview.issues.find((item) => item.code === 'cancelled')?.outcome,
    ).toBe('expected');
  });

  it('references recent metadata in explicit reports without copying content or mixing sessions', () => {
    const { store } = fixture();
    store.record({ ...event, sessionId: 'session-1' });
    store.record({ ...event, sessionId: 'other-session', code: 'other' });
    store.record({
      ...event,
      sessionId: 'session-1',
      outcome: 'quirk',
      code: 'manual-report',
      note: 'Stale widget',
    });
    const report = store
      .overview()
      .issues.find((issue) => issue.outcome === 'quirk')?.samples[0];
    if (!report) throw new Error('Missing explicit report');
    expect(report.context).toEqual([
      expect.objectContaining({
        operation: 'delegate',
        code: 'timeout',
        outcome: 'failure',
      }),
    ]);
    expect(report.context?.[0]).not.toHaveProperty('note');
    expect(
      new TextEncoder().encode(redactTelemetryNote('😀'.repeat(1_000))).length,
    ).toBeLessThanOrEqual(1_000);
  });

  it('drops raw fields and automatic notes instead of trying to sanitize arbitrary output', () => {
    const { store, directory } = fixture();
    expect(
      store.record({
        ...event,
        note: 'PRIVATE OUTPUT',
        errorName: 'PRIVATE ERROR',
        message: 'PRIVATE MESSAGE',
        sessionId: '/Users/private/session.jsonl',
        args: 'PRIVATE ARGUMENTS',
        result: 'PRIVATE RESULT',
        stack: 'PRIVATE STACK',
      } as TelemetryEvent),
    ).toBe(true);
    const sample = store.overview().issues[0].samples[0];
    expect(sample).not.toHaveProperty('note');
    expect(sample).not.toHaveProperty('errorName');
    expect(sample).not.toHaveProperty('sessionId');
    expect(sample).not.toHaveProperty('args');
    const bytes = readFileSync(join(directory, 'events.sqlite')).toString();
    expect(bytes).not.toContain('PRIVATE');
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'events.sqlite')).mode & 0o777).toBe(0o600);
  });

  it('records bounded explicit notes, with credential, URL, and home-path redaction', () => {
    const { store } = fixture();
    const note =
      'Stale widget token=supersecret Bearer abc123 https://example.test/?secret=x /Users/me/private/file sk-secret123';
    expect(
      store.record({ ...event, code: 'manual-report', outcome: 'quirk', note }),
    ).toBe(true);
    const issue = store.overview().issues[0];
    expect(issue.attempts).toBe(0);
    expect(issue.samples[0].note).toContain('Stale widget');
    expect(issue.samples[0].note).not.toMatch(
      /supersecret|abc123|example\.test|private\/file|secret123/,
    );
    expect(redactTelemetryNote('a'.repeat(2_000)).length).toBe(1_000);
    expect(store.record({ ...event, outcome: 'quirk', note: '  ' })).toBe(
      false,
    );
    expect(store.record({ ...event, operation: 'tool /private-path' })).toBe(
      false,
    );
    expect(safeTelemetryErrorName(new TypeError('secret'))).toBe('TypeError');
    expect(
      safeTelemetryErrorName(
        Object.assign(new Error('secret'), { name: 'secret-name' }),
      ),
    ).toBe('Error');
  });

  it('expires records on read and keeps at most the newest event limit on write', () => {
    let now = 0;
    const { store, directory } = fixture(() => now);
    store.record(event);
    now = 31 * 86_400_000;
    expect(store.overview().eventCount).toBe(0);
    const db = new DatabaseSync(join(directory, 'events.sqlite'));
    const insert = db.prepare(
      'INSERT INTO events(timestamp,source,operation,code,outcome,payload) VALUES (?,?,?,?,?,?)',
    );
    db.exec('BEGIN');
    for (let index = 0; index < TELEMETRY_MAX_EVENTS; index++)
      insert.run(
        now,
        event.source,
        event.operation,
        event.code,
        event.outcome,
        JSON.stringify(event),
      );
    db.exec('COMMIT');
    db.close();
    expect(store.record({ ...event, code: 'newest' })).toBe(true);
    const overview = store.overview();
    expect(overview.eventCount).toBe(TELEMETRY_MAX_EVENTS);
    expect(
      overview.issues.find((issue) => issue.code === 'newest')?.count,
    ).toBe(1);
    expect(
      overview.issues.find((issue) => issue.code === 'timeout')?.count,
    ).toBe(TELEMETRY_MAX_EVENTS - 1);
    expect(
      overview.issues.find((issue) => issue.code === 'timeout')?.samples,
    ).toHaveLength(5);
  });

  it('migrates a persisted legacy schema and counts successful HTTP buckets exactly across reopen', () => {
    let now = 3_600_000;
    const directory = mkdtempSync(join(tmpdir(), 'pi-telemetry-legacy-'));
    directories.push(directory);
    const db = new DatabaseSync(join(directory, 'events.sqlite'));
    db.exec(`CREATE TABLE events (
      id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, source TEXT NOT NULL,
      operation TEXT NOT NULL, code TEXT NOT NULL, outcome TEXT NOT NULL, payload TEXT NOT NULL
    )`);
    db.prepare(`INSERT INTO events(timestamp, source, operation, code, outcome, payload)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      1,
      'harness',
      'legacy',
      'failure',
      'failure',
      JSON.stringify({ ...event, timestamp: 1 }),
    );
    db.close();
    const store = new TelemetryStore(directory, () => now);
    stores.push(store);
    const record = (operation: string, version = 'v1', code = 'http-200') =>
      store.record({
        source: 'dashboard-server',
        operation,
        code,
        outcome: 'success',
        version,
      });
    expect(record('http..api.settings')).toBe(true);
    expect(record('http..api.settings')).toBe(true);
    expect(record('http..api.settings', 'v2')).toBe(true);
    expect(record('http..api.settings', 'v1', 'http-201')).toBe(true);
    expect(record('http..api.sessions..id.delegate.history')).toBe(true);
    expect(record('http..api.push.foreground', 'v1', 'http-204')).toBe(true);
    expect(record('http..api.push.foreground', 'v1', 'http-204')).toBe(true);
    expect(record('http..api.push.foreground', 'v2', 'http-204')).toBe(true);
    expect(record('http..api.push.foreground', 'v1', 'http-201')).toBe(true);
    expect(record('http..api.other')).toBe(true);
    expect(
      store.record({
        source: 'dashboard-server',
        operation: 'http..api.settings',
        code: 'http-500',
        outcome: 'failure',
        version: 'v1',
      }),
    ).toBe(true);
    store.close();
    const reopened = new TelemetryStore(directory, () => now);
    stores.push(reopened);
    expect(reopened.overview().eventCount).toBe(10);
    expect(reopened.overview().observationCount).toBe(12);
    const inspect = new DatabaseSync(join(directory, 'events.sqlite'));
    const aggregates = inspect
      .prepare(`SELECT operation, payload, occurrence_count
      FROM events WHERE aggregate_bucket IS NOT NULL`)
      .all() as {
      operation: string;
      payload: string;
      occurrence_count: number;
    }[];
    inspect.close();
    expect(aggregates).toHaveLength(5);
    expect(
      aggregates.filter((row) => row.operation === 'http..api.push.foreground'),
    ).toHaveLength(2);
    expect(
      aggregates.find(
        (row) =>
          row.operation === 'http..api.push.foreground' &&
          JSON.parse(row.payload).version === 'v1',
      )?.occurrence_count,
    ).toBe(2);
    expect(
      aggregates.find((row) => row.operation === 'http..api.settings')
        ?.occurrence_count,
    ).toBe(2);
    const overview = reopened.overview();
    expect(
      overview.issues.find(
        (issue) =>
          issue.operation === 'http..api.settings' && issue.code === 'http-500',
      ),
    ).toMatchObject({ count: 1, attempts: 5, failures: 1 });
    now += 3_600_000;
    expect(
      reopened.record({
        source: 'dashboard-server',
        operation: 'http..api.settings',
        code: 'http-200',
        outcome: 'success',
        version: 'v1',
      }),
    ).toBe(true);
    expect(
      reopened.record({
        source: 'dashboard-server',
        operation: 'http..api.push.foreground',
        code: 'http-204',
        outcome: 'success',
        version: 'v1',
      }),
    ).toBe(true);
    const laterBuckets = new DatabaseSync(join(directory, 'events.sqlite'));
    expect(
      (
        laterBuckets
          .prepare(`SELECT COUNT(*) AS count FROM events
            WHERE operation = 'http..api.push.foreground' AND aggregate_bucket IS NOT NULL`)
          .get() as { count: number }
      ).count,
    ).toBe(3);
    laterBuckets.close();
    expect(reopened.overview().eventCount).toBe(12);
    expect(reopened.overview().observationCount).toBe(14);
  });

  it.each([
    ['failure', 'http-500'],
    ['expected', 'http-204'],
    ['quirk', 'http-204'],
  ] as const)('keeps repeated foreground %s outcomes as individual records', (outcome, code) => {
    const { store } = fixture();
    const event: TelemetryEvent = {
      source: 'dashboard-server',
      operation: 'http..api.push.foreground',
      code,
      outcome,
      version: 'v1',
      ...(outcome === 'quirk' ? { note: 'Foreground push issue' } : {}),
    };
    expect(store.record(event)).toBe(true);
    expect(store.record(event)).toBe(true);
    const overview = store.overview();
    expect(overview.eventCount).toBe(2);
    expect(overview.observationCount).toBe(2);
    expect(
      overview.issues.find((issue) => issue.outcome === outcome),
    ).toMatchObject({
      count: 2,
      attempts: outcome === 'quirk' ? 0 : 2,
      failures: outcome === 'failure' ? 2 : 0,
    });
  });

  it.each([
    ['http..api.settings', 'http-204'],
    ['http..api.sessions..id.delegate.history', 'http-204'],
    ['http..api.push.foreground', 'http-200'],
  ])('does not aggregate an unlisted operation/status pair: %s %s', (operation, code) => {
    const { store } = fixture();
    const event: TelemetryEvent = {
      source: 'dashboard-server',
      operation,
      code,
      outcome: 'success',
      version: 'v1',
    };
    expect(store.record(event)).toBe(true);
    expect(store.record(event)).toBe(true);
    expect(store.overview()).toMatchObject({
      eventCount: 2,
      observationCount: 2,
      issues: [],
    });
  });

  it('does not evict another row when an HTTP aggregate bucket is updated at capacity', () => {
    let now = 100;
    const { store, directory } = fixture(() => now);
    const aggregate: TelemetryEvent = {
      source: 'dashboard-server',
      operation: 'http..api.push.foreground',
      code: 'http-204',
      outcome: 'success',
      version: 'v1',
    };
    expect(store.record(aggregate)).toBe(true);
    const db = new DatabaseSync(join(directory, 'events.sqlite'));
    const insert = db.prepare(
      'INSERT INTO events(timestamp,source,operation,code,outcome,payload) VALUES (?,?,?,?,?,?)',
    );
    db.exec('BEGIN');
    for (let index = 0; index < TELEMETRY_MAX_EVENTS - 1; index++)
      insert.run(
        now,
        'harness',
        `operation${index}`,
        'timeout',
        'failure',
        JSON.stringify({
          source: 'harness',
          operation: `operation${index}`,
          code: 'timeout',
          outcome: 'failure',
          version: 'pi-test',
        }),
      );
    db.exec('COMMIT');
    db.close();
    now++;
    expect(store.record(aggregate)).toBe(true);
    const overview = store.overview();
    expect(overview.eventCount).toBe(TELEMETRY_MAX_EVENTS);
    expect(overview.observationCount).toBe(TELEMETRY_MAX_EVENTS + 1);
    expect(overview.lastTimestamp).toBe(now);
    const persisted = new DatabaseSync(join(directory, 'events.sqlite'));
    expect(
      persisted
        .prepare(
          "SELECT COUNT(*) AS count FROM events WHERE operation = 'operation0'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      (
        persisted
          .prepare(
            'SELECT occurrence_count FROM events WHERE aggregate_bucket IS NOT NULL',
          )
          .get() as { occurrence_count: number }
      ).occurrence_count,
    ).toBe(2);
    persisted.close();
  });

  it('uses the event time for legacy-style inserts that omit last_timestamp', () => {
    const { store, directory } = fixture(() => 100);
    store.record(event);
    const db = new DatabaseSync(join(directory, 'events.sqlite'));
    db.prepare(
      'INSERT INTO events(timestamp,source,operation,code,outcome,payload) VALUES (?,?,?,?,?,?)',
    ).run(
      200,
      event.source,
      event.operation,
      event.code,
      event.outcome,
      JSON.stringify(event),
    );
    db.close();
    expect(store.overview()).toMatchObject({
      eventCount: 2,
      observationCount: 2,
      firstTimestamp: 100,
      lastTimestamp: 200,
    });
  });

  it('expires whole hourly aggregates by their first timestamp and reports the retained window', () => {
    let now = 1;
    const { store } = fixture(() => now);
    const aggregate: TelemetryEvent = {
      source: 'dashboard-server',
      operation: 'http..api.push.foreground',
      code: 'http-204',
      outcome: 'success',
      version: 'v1',
    };
    store.record(aggregate);
    now = 2_000;
    store.record(aggregate);
    let overview = store.overview();
    expect(overview.eventCount).toBe(1);
    expect(overview.observationCount).toBe(2);
    expect(overview.firstTimestamp).toBe(1);
    expect(overview.lastTimestamp).toBe(2_000);
    now = 30 * 86_400_000 + 2;
    overview = store.overview();
    expect(overview.eventCount).toBe(0);
    expect(overview.observationCount).toBe(0);
    expect(overview.firstTimestamp).toBeNull();
    expect(overview.lastTimestamp).toBeNull();
    const { store: empty } = fixture();
    expect(empty.overview()).toMatchObject({
      eventCount: 0,
      observationCount: 0,
      firstTimestamp: null,
      lastTimestamp: null,
    });
  });

  it('fails safely for corrupt storage and competing writers without changing the operation', () => {
    const { store, directory } = fixture();
    writeFileSync(join(directory, 'events.sqlite'), 'not a database');
    chmodSync(join(directory, 'events.sqlite'), 0o600);
    expect(store.record(event)).toBe(false);
    expect(store.overview()).toMatchObject({ available: false, issues: [] });
    const second = fixture();
    second.store.record(event);
    const lock = new DatabaseSync(join(second.directory, 'events.sqlite'));
    lock.exec('BEGIN IMMEDIATE');
    expect(second.store.record(event)).toBe(false);
    lock.exec('ROLLBACK');
    lock.close();
    expect(second.store.record(event)).toBe(true);
  });
});
