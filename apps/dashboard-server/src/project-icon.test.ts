import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteProjectIconOverride,
  readProjectIcon,
  readProjectIconOverride,
  writeProjectIconOverride,
} from './project-icon.js';

const roots: string[] = [];

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-project-icon-'));
  roots.push(root);
  return root;
}

async function fixture(
  root: string,
  relativePath: string,
  content: string | Buffer,
): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe('project icon overrides', () => {
  it('stores uploaded icons as bounded PNG files and deletes them', async () => {
    const stateDir = await projectRoot();
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>',
    );

    await writeProjectIconOverride(stateDir, 'project/1', source);
    const stored = await readProjectIconOverride(stateDir, 'project/1');

    expect(stored?.mediaType).toBe('image/png');
    expect(stored?.data.subarray(1, 4).toString()).toBe('PNG');
    await deleteProjectIconOverride(stateDir, 'project/1');
    expect(
      await readProjectIconOverride(stateDir, 'project/1'),
    ).toBeUndefined();
  });

  it('rejects invalid uploaded files', async () => {
    const stateDir = await projectRoot();

    await expect(
      writeProjectIconOverride(stateDir, 'project-1', Buffer.from('nope')),
    ).rejects.toThrow('valid image');
  });
});

describe('readProjectIcon', () => {
  it('uses well-known candidates in order', async () => {
    const root = await projectRoot();
    await fixture(root, 'public/favicon.png', Buffer.from('png'));
    await fixture(root, 'assets/logo.svg', '<svg>logo</svg>');

    const icon = await readProjectIcon(root);

    expect(icon).toEqual({ data: Buffer.from('png'), mediaType: 'image/png' });
  });

  it('resolves icon links from project HTML', async () => {
    const root = await projectRoot();
    await fixture(
      root,
      'index.html',
      '<html><head><link href="/brand/icon.webp?v=2" rel="icon"></head></html>',
    );
    await fixture(root, 'public/brand/icon.webp', Buffer.from('webp'));

    const icon = await readProjectIcon(root);

    expect(icon).toEqual({
      data: Buffer.from('webp'),
      mediaType: 'image/webp',
    });
  });

  it('rejects icon links that escape the project root', async () => {
    const root = await projectRoot();
    const outside = path.join(path.dirname(root), 'outside.svg');
    await writeFile(outside, '<svg>secret</svg>');
    roots.push(outside);
    await fixture(
      root,
      'index.html',
      '<html><head><link rel="icon" href="../outside.svg"></head></html>',
    );

    expect(await readProjectIcon(root)).toBeUndefined();
  });
});
