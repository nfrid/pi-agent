import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheFileRoot, clearCacheFiles, writeCacheFile } from './cache-files';

const roots: string[] = [];

async function temporaryCacheHome(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-cache-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('cache files', () => {
  it('writes opaque private files atomically under the cache home', async () => {
    const cacheHome = await temporaryCacheHome();
    const file = await writeCacheFile('hello🙂', '.md', { cacheHome });
    expect(file.path).toBe(path.resolve(file.path));
    expect(file.path).toContain(cacheFileRoot(cacheHome));
    expect(path.basename(file.path)).toMatch(/^[a-f0-9]{32}\.md$/);
    expect(file.size).toBe(Buffer.byteLength('hello🙂'));
    expect(await readFile(file.path, 'utf8')).toBe('hello🙂');
    expect((await stat(cacheFileRoot(cacheHome))).mode & 0o777).toBe(0o700);
    expect((await stat(file.path)).mode & 0o777).toBe(0o600);
  });

  it('rejects unsafe extensions and removes its owned directory on request', async () => {
    const cacheHome = await temporaryCacheHome();
    await expect(
      writeCacheFile('x', '../secret', { cacheHome }),
    ).rejects.toThrow('safe extension');
    await writeCacheFile('x', 'json', { cacheHome });
    await clearCacheFiles(cacheHome);
    await expect(stat(cacheFileRoot(cacheHome))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
