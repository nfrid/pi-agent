import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MetadataStore } from './metadata.js';

describe('dashboard metadata wire boundaries', () => {
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
