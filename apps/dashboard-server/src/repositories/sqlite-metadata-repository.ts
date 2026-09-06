import type { DatabaseSync } from 'node:sqlite';
import type {
  RuntimeLocation,
  RuntimeSnapshot,
  SessionIndexEntry,
} from '@pi-dashboard/protocol';
import { credentialHash } from '../metadata-credentials.js';
import type {
  ManagedLaunchIdentity,
  ManagedLaunchRecord,
  MetadataRepository,
} from './types.js';

export class SqliteMetadataRepository implements MetadataRepository {
  constructor(private readonly db: DatabaseSync) {}

  saveRuntime(snapshot: RuntimeSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO runtime (id,ownership,session_id,cwd,state,online,last_seen_at,snapshot_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ownership=excluded.ownership,session_id=excluded.session_id,cwd=excluded.cwd,state=excluded.state,online=excluded.online,last_seen_at=excluded.last_seen_at,snapshot_json=excluded.snapshot_json`,
      )
      .run(
        snapshot.runtimeId,
        snapshot.ownership,
        snapshot.session.id,
        snapshot.cwd,
        snapshot.liveState,
        snapshot.online === false ? 0 : 1,
        snapshot.lastSeenAt ?? Date.now(),
        JSON.stringify({
          ...snapshot,
          session: { ...snapshot.session, entries: [] },
        }),
      );
  }

  saveSession(session: SessionIndexEntry): void {
    this.db
      .prepare(
        `INSERT INTO session_index (id,file,cwd,workspace_id,name,updated_at,entry_count) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET file=excluded.file,cwd=excluded.cwd,workspace_id=excluded.workspace_id,name=excluded.name,updated_at=excluded.updated_at,entry_count=excluded.entry_count`,
      )
      .run(
        session.id,
        session.file,
        session.cwd,
        null,
        session.name ?? null,
        session.updatedAt,
        session.entryCount ?? null,
      );
  }

  recordManagedLaunch(
    runtimeId: string,
    identity: ManagedLaunchIdentity,
    location: RuntimeLocation,
    credentials: {
      identityToken: string;
      launchToken: string;
      launchConsumed?: boolean;
      mode?: 'read' | 'write';
    },
    owningIntentId?: string,
  ): void {
    const value = identity;
    const result = this.db
      .prepare(
        `INSERT INTO managed_launch (runtime_id,workspace_id,project_id,checkout_id,cwd,runtime_location_json,launched_at,stopped_at,identity_token_hash,launch_token_hash,launch_consumed,mode)
         SELECT ?,?,?,?,?,?,?,NULL,?,?,?,?
         WHERE NOT EXISTS (SELECT 1 FROM command_receipt WHERE planned_runtime_id=?)
           AND ? IS NULL
           OR EXISTS (SELECT 1 FROM command_receipt WHERE planned_runtime_id=?
             AND idempotency_key=? AND execution_state='launching'
             AND command_type IN ('runtime.start','runtime.restart'))`,
      )
      .run(
        runtimeId,
        null,
        value.projectId ?? null,
        value.checkoutId ?? null,
        value.cwd ?? null,
        JSON.stringify(location),
        Date.now(),
        credentialHash(credentials.identityToken),
        credentialHash(credentials.launchToken),
        credentials.launchConsumed ? 1 : 0,
        credentials.mode ?? 'write',
        runtimeId,
        owningIntentId ?? null,
        runtimeId,
        owningIntentId ?? null,
      );
    if (Number(result.changes) !== 1)
      throw new Error(
        'Runtime launch does not own its durable intent reservation.',
      );
  }

  managedLaunches(): ManagedLaunchRecord[] {
    return this.readManagedLaunches('WHERE stopped_at IS NULL');
  }

  managedLaunchHistory(): ManagedLaunchRecord[] {
    return this.readManagedLaunches('');
  }

  private readManagedLaunches(filter: string): ManagedLaunchRecord[] {
    const where = filter.length > 0 ? `${filter} AND` : 'WHERE';
    return (
      this.db
        .prepare(
          `SELECT runtime_id as runtimeId,project_id as projectId,checkout_id as checkoutId,cwd,runtime_location_json as locationJson,launched_at as launchedAt,ready_at as readyAt,stopped_at as stoppedAt,identity_token_hash as identityTokenHash,launch_token_hash as launchTokenHash,launch_consumed as launchConsumed,mode FROM managed_launch ${where} runtime_location_json IS NOT NULL`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      runtimeId: String(row.runtimeId),
      ...(row.projectId == null ? {} : { projectId: String(row.projectId) }),
      ...(row.checkoutId == null ? {} : { checkoutId: String(row.checkoutId) }),
      ...(row.cwd == null ? {} : { cwd: String(row.cwd) }),
      location: (() => {
        try {
          const value: unknown = JSON.parse(String(row.locationJson));
          if (value && typeof value === 'object' && !Array.isArray(value))
            return value as RuntimeLocation;
        } catch {
          /* malformed legacy rows are not recoverable */
        }
        return { id: `unrecoverable:${row.runtimeId}` };
      })(),
      identityTokenHash: String(row.identityTokenHash ?? ''),
      launchTokenHash: String(row.launchTokenHash ?? ''),
      launchConsumed: Number(row.launchConsumed) === 1,
      mode: row.mode === 'read' ? 'read' : 'write',
      launchedAt: Number(row.launchedAt),
      ...(row.readyAt == null ? {} : { readyAt: Number(row.readyAt) }),
      ...(row.stoppedAt == null ? {} : { stoppedAt: Number(row.stoppedAt) }),
    }));
  }

  consumeLaunchCredential(runtimeId: string): void {
    this.db
      .prepare(
        'UPDATE managed_launch SET launch_consumed=1 WHERE runtime_id=? AND stopped_at IS NULL',
      )
      .run(runtimeId);
  }

  markManagedReady(runtimeId: string, readyAt = Date.now()): void {
    this.db
      .prepare('UPDATE managed_launch SET ready_at=? WHERE runtime_id=?')
      .run(readyAt, runtimeId);
  }

  markManagedStopped(runtimeId: string): void {
    this.db
      .prepare('UPDATE managed_launch SET stopped_at=? WHERE runtime_id=?')
      .run(Date.now(), runtimeId);
  }
}
