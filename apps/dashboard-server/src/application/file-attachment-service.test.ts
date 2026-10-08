import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachmentManifest,
  FileAttachmentService,
} from './file-attachment-service.js';

const roots: string[] = [];
async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'dashboard-files-'));
  roots.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

describe('FileAttachmentService', () => {
  it('stores empty and ordinary files privately with safe names that survive restart', async () => {
    const directory = await root();
    const service = new FileAttachmentService(directory);
    await service.start();
    const [empty, text] = await service.save([
      { name: 'C:\\users\\private\\empty.txt', data: Buffer.alloc(0) },
      { name: '../../report final.pdf', data: Buffer.from('report') },
    ]);
    expect(empty).toMatchObject({ originalName: 'empty.txt', size: 0 });
    expect(empty.name).toMatch(/^[a-f0-9]{24}-empty\.txt$/);
    expect(text).toMatchObject({ originalName: 'report final.pdf', size: 6 });
    expect(text.name).toMatch(/^[a-f0-9]{24}-report_final\.pdf$/);
    expect(await readFile(text.path, 'utf8')).toBe('report');
    expect((await stat(text.path)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(path.join(directory, 'file-attachments'))).mode & 0o777,
    ).toBe(0o700);
    const restarted = new FileAttachmentService(directory);
    await restarted.start();
    expect(await readFile(empty.path)).toEqual(Buffer.alloc(0));
    expect(attachmentManifest([text])).toContain(
      JSON.stringify('report final.pdf'),
    );
    expect(attachmentManifest([text])).toContain(JSON.stringify(text.path));
  });

  it('keeps saved files until their owner explicitly removes them', async () => {
    const directory = await root();
    const service = new FileAttachmentService(directory);
    await service.start();
    const [retained, removed] = await service.save([
      { name: 'accepted.bin', data: Buffer.from([1]) },
      { name: 'rejected.bin', data: Buffer.from([2]) },
    ]);
    expect(await readdir(path.join(directory, 'file-attachments'))).toEqual(
      expect.arrayContaining([retained.name, removed.name]),
    );
    await service.cleanup([removed]);
    expect(await readdir(path.join(directory, 'file-attachments'))).toEqual([
      retained.name,
    ]);
    await expect(readFile(retained.path)).resolves.toEqual(Buffer.from([1]));
  });
});
