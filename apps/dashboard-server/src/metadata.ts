import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  NotificationEvent,
  RuntimeSnapshot,
  SessionIndexEntry,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';

export interface PushSubscriptionRecord {
  endpoint: string;
  subscription: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface ManagedLaunchRecord {
  runtimeId: string;
  workspaceId: string;
  placement: {
    tmuxSession: string;
    tmuxWindowId: string;
    tmuxPaneId: string;
    displayTarget: string;
  };
  identityTokenHash: string;
  launchTokenHash: string;
  launchConsumed: boolean;
  launchedAt: number;
  stoppedAt?: number;
}

export function credentialHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Dashboard metadata only. Transcript/session contents never enter SQLite. */
export class MetadataStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      chmodSync(path.dirname(file), 0o700);
    } catch {
      /* best effort on non-POSIX test hosts */
    }
    this.db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, path TEXT NOT NULL, canonical_path TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL, active INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime (id TEXT PRIMARY KEY, ownership TEXT NOT NULL, session_id TEXT, cwd TEXT NOT NULL, state TEXT NOT NULL, online INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, snapshot_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_index (id TEXT PRIMARY KEY, file TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL, workspace_id TEXT, name TEXT, updated_at INTEGER NOT NULL, entry_count INTEGER);
      CREATE TABLE IF NOT EXISTS managed_launch (runtime_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, tmux_session TEXT NOT NULL, tmux_window_id TEXT NOT NULL, tmux_pane_id TEXT NOT NULL, launched_at INTEGER NOT NULL, stopped_at INTEGER, identity_token_hash TEXT, launch_token_hash TEXT, launch_consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS interaction (id TEXT PRIMARY KEY, runtime_id TEXT, session_id TEXT, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notification (id TEXT PRIMARY KEY, kind TEXT NOT NULL, runtime_id TEXT, session_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);
      CREATE TABLE IF NOT EXISTS push_subscription (endpoint TEXT PRIMARY KEY, subscription_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    `);
    // Add credential columns to databases created by the first dashboard build.
    const columns = new Set(
      (
        this.db.prepare('PRAGMA table_info(managed_launch)').all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    if (!columns.has('identity_token_hash'))
      this.db.exec(
        'ALTER TABLE managed_launch ADD COLUMN identity_token_hash TEXT',
      );
    if (!columns.has('launch_token_hash'))
      this.db.exec(
        'ALTER TABLE managed_launch ADD COLUMN launch_token_hash TEXT',
      );
    if (!columns.has('launch_consumed'))
      this.db.exec(
        'ALTER TABLE managed_launch ADD COLUMN launch_consumed INTEGER NOT NULL DEFAULT 0',
      );
  }

  saveWorkspace(workspace: WorkspaceTarget): void {
    this.db
      .prepare(
        `INSERT INTO workspace (id,path,canonical_path,name,source,active,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,canonical_path=excluded.canonical_path,name=excluded.name,source=excluded.source,active=excluded.active,updated_at=excluded.updated_at`,
      )
      .run(
        workspace.id,
        workspace.path,
        workspace.canonicalPath,
        workspace.name,
        workspace.source,
        workspace.active ? 1 : 0,
        Date.now(),
      );
  }

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
        session.workspaceId ?? null,
        session.name ?? null,
        session.updatedAt,
        session.entryCount ?? null,
      );
  }

  recordManagedLaunch(
    runtimeId: string,
    workspaceId: string,
    placement: {
      tmuxSession: string;
      tmuxWindowId: string;
      tmuxPaneId: string;
      displayTarget?: string;
    },
    credentials: {
      identityToken: string;
      launchToken: string;
      launchConsumed?: boolean;
    },
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO managed_launch (runtime_id,workspace_id,tmux_session,tmux_window_id,tmux_pane_id,launched_at,stopped_at,identity_token_hash,launch_token_hash,launch_consumed) VALUES (?,?,?,?,?,?,NULL,?,?,?)`,
      )
      .run(
        runtimeId,
        workspaceId,
        placement.tmuxSession,
        placement.tmuxWindowId,
        placement.tmuxPaneId,
        Date.now(),
        credentialHash(credentials.identityToken),
        credentialHash(credentials.launchToken),
        ...(credentials.launchConsumed ? [1] : [0]),
      );
  }

  managedLaunches(): ManagedLaunchRecord[] {
    return (
      this.db
        .prepare(
          'SELECT runtime_id as runtimeId,workspace_id as workspaceId,tmux_session as tmuxSession,tmux_window_id as tmuxWindowId,tmux_pane_id as tmuxPaneId,launched_at as launchedAt,stopped_at as stoppedAt,identity_token_hash as identityTokenHash,launch_token_hash as launchTokenHash,launch_consumed as launchConsumed FROM managed_launch WHERE stopped_at IS NULL',
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      runtimeId: String(row.runtimeId),
      workspaceId: String(row.workspaceId),
      placement: {
        tmuxSession: String(row.tmuxSession),
        tmuxWindowId: String(row.tmuxWindowId),
        tmuxPaneId: String(row.tmuxPaneId),
        displayTarget: `${row.tmuxSession}:${row.tmuxWindowId}`,
      },
      identityTokenHash: String(row.identityTokenHash ?? ''),
      launchTokenHash: String(row.launchTokenHash ?? ''),
      launchConsumed: Number(row.launchConsumed) === 1,
      launchedAt: Number(row.launchedAt),
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

  markManagedStopped(runtimeId: string): void {
    this.db
      .prepare('UPDATE managed_launch SET stopped_at=? WHERE runtime_id=?')
      .run(Date.now(), runtimeId);
  }

  addNotification(event: NotificationEvent): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO notification (id,kind,runtime_id,session_id,title,body,created_at,read_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        event.id,
        event.kind,
        event.runtimeId ?? null,
        event.sessionId ?? null,
        event.title,
        event.body,
        event.createdAt,
        event.readAt ?? null,
      );
  }

  unreadNotifications(): NotificationEvent[] {
    return this.db
      .prepare(
        'SELECT id,kind,runtime_id as runtimeId,session_id as sessionId,title,body,created_at as createdAt,read_at as readAt FROM notification WHERE read_at IS NULL ORDER BY created_at DESC LIMIT 100',
      )
      .all() as unknown as NotificationEvent[];
  }

  markNotificationRead(id: string): void {
    this.db
      .prepare('UPDATE notification SET read_at=? WHERE id=?')
      .run(Date.now(), id);
  }

  clearWaitingNotifications(runtimeId: string): void {
    this.db
      .prepare(
        "UPDATE notification SET read_at=? WHERE runtime_id=? AND kind='waiting' AND read_at IS NULL",
      )
      .run(Date.now(), runtimeId);
  }

  savePushSubscription(record: PushSubscriptionRecord): void {
    this.db
      .prepare(
        `INSERT INTO push_subscription (endpoint,subscription_json,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json=excluded.subscription_json,updated_at=excluded.updated_at`,
      )
      .run(
        record.endpoint,
        JSON.stringify(record.subscription),
        record.createdAt,
        record.updatedAt,
      );
  }

  pushSubscriptions(): PushSubscriptionRecord[] {
    return this.db
      .prepare(
        'SELECT endpoint,subscription_json as subscriptionJson,created_at as createdAt,updated_at as updatedAt FROM push_subscription',
      )
      .all()
      .map((row) => ({
        endpoint: String(row.endpoint),
        subscription: JSON.parse(String(row.subscriptionJson)),
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
      }));
  }

  close(): void {
    this.db.close();
  }
}
