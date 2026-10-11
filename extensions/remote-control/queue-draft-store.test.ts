import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueueDraftStore } from './queue-draft-store';

describe('native steer queue claims', () => {
  it('claims only the first steer draft at its exact current revision', () => {
    const store = new QueueDraftStore();
    store.setSession('session-a');
    store.add({ clientId: 'followup', mode: 'followUp', text: 'later' });
    store.add({ clientId: 'steer-1', mode: 'steer', text: 'first steer' });
    store.add({ clientId: 'steer-2', mode: 'steer', text: 'second steer' });

    expect(store.claimSteerNow('steer-2', 1)).toBeUndefined();
    expect(store.claimSteerNow('steer-1', 2)).toBeUndefined();
    const claimed = store.claimSteerNow('steer-1', 1);
    expect(claimed).toMatchObject({ clientId: 'steer-1', revision: 1 });
    expect(store.listHandoffs()).toMatchObject([
      { clientId: 'steer-1', status: 'handing-off' },
    ]);
    expect(store.claimSteerNow('steer-1', 1)).toBeUndefined();
  });

  it('does not claim steer drafts that contain images', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-steer-image-'));
    const file = join(directory, 'image.png');
    await writeFile(file, Buffer.from([1, 2, 3]));
    const store = new QueueDraftStore();
    store.setSession('session-image');
    store.add({
      clientId: 'image-draft',
      mode: 'steer',
      text: '',
      images: [{ type: 'image', path: file, mediaType: 'image/png' }],
    });

    expect(store.claimSteerNow('image-draft', 1)).toBeUndefined();
    expect(store.list()).toMatchObject([
      { clientId: 'image-draft', imageCount: 1 },
    ]);
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps a claimed draft editable after known failure, but not uncertainty', () => {
    const store = new QueueDraftStore();
    store.setSession('session-a');
    store.add({ clientId: 'draft', mode: 'steer', text: 'input' });
    const claimed = store.claimSteerNow('draft', 1);
    if (!claimed) throw new Error('expected queue claim');

    store.resolveHandoff(claimed, 'failed', 'rejected');
    expect(store.list()).toHaveLength(1);
    expect(store.claimSteerNow('draft', 1)).toBeDefined();
    store.resolveHandoff(claimed, 'uncertain', 'ack timed out');
    expect(store.claimSteerNow('draft', 1)).toBeUndefined();
  });
});
