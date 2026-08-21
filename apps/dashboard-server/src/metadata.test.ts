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
      store.recordManagedLaunch('read-runtime', 'workspace', location, {
        identityToken: 'identity-read',
        launchToken: 'launch-read',
        mode: 'read',
      });
      store.recordManagedLaunch(
        'write-runtime',
        'workspace',
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
