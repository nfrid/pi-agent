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
