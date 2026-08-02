import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionIndex } from './session-index.js';

describe('session index', () => {
  it('rebuilds from Pi JSONL headers and only reads known IDs', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-sessions-'),
    );
    await mkdir(path.join(root, 'project'));
    const file = path.join(root, 'project', 'session.jsonl');
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', version: 3, id: 'session-id', cwd: '/tmp/project' })}\n${JSON.stringify({ type: 'message', id: 'entry' })}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    expect(index.list()[0]).toMatchObject({
      id: 'session-id',
      file,
      entryCount: 2,
    });
    await expect(index.readEntries('not-known')).rejects.toThrow(
      'Unknown session',
    );
    await expect(index.readEntries('session-id')).resolves.toMatchObject({
      entries: [{ type: 'session' }, { type: 'message' }],
    });
  });
});
