import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MetadataStore } from './metadata.js';

describe('dashboard metadata wire boundaries', () => {
  it('marks every unread notification as read', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-metadata-'),
    );
    const store = new MetadataStore(path.join(root, 'dashboard.sqlite'));
    try {
      for (const [id, createdAt] of [
        ['notification-1', 1],
        ['notification-2', 2],
      ] as const) {
        store.addNotification({
          id,
          kind: 'settled',
          title: 'Finished',
          body: 'Done',
          createdAt,
        });
      }
      store.markAllNotificationsRead();
      expect(store.unreadNotifications()).toEqual([]);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists managed launch mode and defaults omitted mode to write', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-metadata-'),
    );
    const store = new MetadataStore(path.join(root, 'dashboard.sqlite'));
    try {
      const location = {
        id: 'host:read-runtime',
        displayTarget: 'runtime-host://read-runtime',
      };
      store.recordManagedLaunch(
        'read-runtime',
        { projectId: 'project', checkoutId: 'checkout', cwd: '/tmp' },
        location,
        {
          identityToken: 'identity-read',
          launchToken: 'launch-read',
          mode: 'read',
        },
      );
      store.recordManagedLaunch(
        'write-runtime',
        { projectId: 'project', checkoutId: 'checkout', cwd: '/tmp' },
        {
          id: 'host:write-runtime',
          displayTarget: 'runtime-host://write-runtime',
        },
        {
          identityToken: 'identity-write',
          launchToken: 'launch-write',
        },
      );
      expect(store.managedLaunches()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runtimeId: 'read-runtime',
            mode: 'read',
            location,
          }),
          expect.objectContaining({
            runtimeId: 'write-runtime',
            mode: 'write',
          }),
        ]),
      );
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers an authenticated PID from a fresh owned snapshot', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-metadata-pid-'),
    );
    const store = new MetadataStore(path.join(root, 'dashboard.sqlite'));
    try {
      store.recordManagedLaunch(
        'runtime-pid',
        { cwd: '/tmp' },
        { id: 'host:runtime-pid' },
        { identityToken: 'identity', launchToken: 'launch' },
      );
      store.saveRuntime({
        runtimeId: 'runtime-pid',
        ownership: 'managed',
        pid: 4321,
        cwd: '/tmp',
        liveState: 'idle',
        session: { id: 'session-pid', entries: [] },
        lastSeenAt: Date.now(),
      } as never);
      expect(store.managedLaunches()).toEqual([
        expect.objectContaining({ runtimeId: 'runtime-pid', processId: 4321 }),
      ]);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['stale timestamp', 'stale'],
    ['malformed JSON', 'malformed'],
    ['runtime ID mismatch', 'runtime-id'],
    ['ownership mismatch', 'ownership'],
    ['invalid PID', 'pid'],
  ] as const)('does not recover a PID for %s metadata', async (_name, kind) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), `pi-dashboard-metadata-negative-${kind}-`),
    );
    const store = new MetadataStore(path.join(root, 'dashboard.sqlite'));
    const runtimeId = `runtime-negative-${kind}`;
    try {
      store.recordManagedLaunch(
        runtimeId,
        { cwd: '/tmp' },
        { id: `host:${runtimeId}` },
        { identityToken: 'identity', launchToken: 'launch' },
      );
      const launchRow = store.db
        .prepare(
          'SELECT launched_at as launchedAt FROM managed_launch WHERE runtime_id=?',
        )
        .get(runtimeId) as { launchedAt: number };
      const launchedAt = Number(launchRow.launchedAt);
      store.saveRuntime({
        runtimeId,
        ownership: kind === 'ownership' ? 'external' : 'managed',
        pid: kind === 'pid' ? 0 : 4321,
        cwd: '/tmp',
        liveState: 'idle',
        session: { id: `session-${kind}`, entries: [] },
        lastSeenAt: kind === 'stale' ? launchedAt - 1 : launchedAt + 1,
      } as never);
      if (kind === 'malformed')
        store.db
          .prepare('UPDATE runtime SET snapshot_json=? WHERE id=?')
          .run('{', runtimeId);
      if (kind === 'runtime-id')
        store.db.prepare('UPDATE runtime SET snapshot_json=? WHERE id=?').run(
          JSON.stringify({
            runtimeId: 'different-runtime',
            ownership: 'managed',
            pid: 4321,
          }),
          runtimeId,
        );
      expect(
        store.managedLaunches().find((record) => record.runtimeId === runtimeId)
          ?.processId,
      ).toBeUndefined();
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('omits nullable SQLite notification fields from browser snapshots', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-metadata-'),
    );
    const store = new MetadataStore(path.join(root, 'dashboard.sqlite'));
    try {
      store.addNotification({
        id: 'notification-1',
        kind: 'settled',
        title: 'Finished',
        body: 'Done',
        createdAt: 1,
      });
      expect(store.unreadNotifications()).toEqual([
        {
          id: 'notification-1',
          kind: 'settled',
          title: 'Finished',
          body: 'Done',
          createdAt: 1,
        },
      ]);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
