import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionIndex } from './session-index.js';

describe('session index', () => {
  it('refreshes workspace ownership and removes deleted session files', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-session-refresh-'),
    );
    const directory = path.join(root, 'project');
    await mkdir(directory);
    const file = path.join(directory, 'session.jsonl');
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', id: 'refresh-id', cwd: '/workspace/project' })}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    expect(index.list('workspace-1')).toHaveLength(0);
    await index.refresh([
      {
        id: 'workspace-1',
        name: 'Workspace',
        path: '/workspace',
        canonicalPath: '/workspace',
        source: 'directory',
        active: true,
      },
    ]);
    expect(index.list('workspace-1')).toHaveLength(1);
    await rm(file);
    await index.refresh([
      {
        id: 'workspace-1',
        name: 'Workspace',
        path: '/workspace',
        canonicalPath: '/workspace',
        source: 'directory',
        active: true,
      },
    ]);
    expect(index.get('refresh-id')).toBeUndefined();
  });

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
    });
    expect(index.list()[0]?.entryCount).toBeUndefined();
    await expect(index.readEntries('not-known')).rejects.toThrow(
      'Unknown session',
    );
    await expect(index.readEntries('session-id')).resolves.toMatchObject({
      entries: [{ type: 'session' }, { type: 'message' }],
    });
  });

  it('uses latest session_info and first user message, not header.name', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-titles-'));
    const file = path.join(root, 'session.jsonl');
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', id: 'title-id', cwd: '/tmp', name: 'Header name' })}\n${JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '  Investigate   the dashboard\n  title  ' }] } })}\n${JSON.stringify({ type: 'session_info', id: 'i1', parentId: 'm1', timestamp: new Date().toISOString(), name: 'Old name' })}\n${JSON.stringify({ type: 'session_info', id: 'i2', parentId: 'i1', timestamp: new Date().toISOString(), name: 'Latest name' })}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    expect(index.get('title-id')).toMatchObject({
      name: 'Latest name',
      title: 'Investigate the dashboard title',
    });
  });

  it('renames a known dormant session by appending session_info', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-rename-'));
    const file = path.join(root, 'session.jsonl');
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', id: 'rename-id', cwd: '/tmp' })}\n${JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'first request' } })}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    await expect(
      index.rename('rename-id', 'Renamed session'),
    ).resolves.toMatchObject({
      id: 'rename-id',
      name: 'Renamed session',
      title: 'first request',
    });
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    const appended = JSON.parse(lines.at(-1) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(appended).toMatchObject({
      type: 'session_info',
      parentId: 'm1',
      name: 'Renamed session',
    });
    expect(typeof appended.id).toBe('string');
    expect(typeof appended.timestamp).toBe('string');
  });
});
