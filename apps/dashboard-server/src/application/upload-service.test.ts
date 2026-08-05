import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UploadService } from './upload-service.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('UploadService', () => {
  it('owns temporary image files and cleans them after a command', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-upload-'));
    const uploads = new UploadService(root);
    await uploads.start();
    const [image] = await uploads.save([png]);
    await expect(readFile(image.path)).resolves.toEqual(png);
    await uploads.cleanup([image.path]);
    await expect(readdir(path.join(root, 'uploads'))).resolves.toEqual([]);
    await uploads.close();
  });

  it('rejects more than the bounded image count without writing files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-upload-'));
    const uploads = new UploadService(root);
    await uploads.start();
    await expect(uploads.save([png, png, png, png, png])).rejects.toThrow(
      'between one and four',
    );
    await expect(readdir(path.join(root, 'uploads'))).resolves.toEqual([]);
    await uploads.close();
  });
});
