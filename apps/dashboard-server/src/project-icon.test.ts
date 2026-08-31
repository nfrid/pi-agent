import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProjectIcon } from './project-icon.js';

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

describe('readProjectIcon', () => {
  it('prefers a t3.json iconPath over well-known files', async () => {
    const root = await projectRoot();
    await fixture(
      root,
      't3.json',
      JSON.stringify({ iconPath: 'brand/mark.svg' }),
    );
    await fixture(root, 'brand/mark.svg', '<svg>configured</svg>');
    await fixture(root, 'favicon.svg', '<svg>automatic</svg>');

    const icon = await readProjectIcon(root);

    expect(icon?.mediaType).toBe('image/svg+xml');
    expect(icon?.data.toString()).toContain('configured');
  });

  it('uses well-known candidates in order', async () => {
    const root = await projectRoot();
    await fixture(root, 'public/favicon.png', Buffer.from('png'));
    await fixture(root, 'assets/logo.svg', '<svg>logo</svg>');

    const icon = await readProjectIcon(root);

    expect(icon).toEqual({ data: Buffer.from('png'), mediaType: 'image/png' });
  });

  it('falls back when t3.json points to an unsupported file', async () => {
    const root = await projectRoot();
    await fixture(root, 't3.json', JSON.stringify({ iconPath: 'README.md' }));
    await fixture(root, 'README.md', 'not an image');
    await fixture(root, 'favicon.svg', '<svg>automatic</svg>');

    const icon = await readProjectIcon(root);

    expect(icon?.data.toString()).toContain('automatic');
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

  it('rejects configured paths that escape the project root', async () => {
    const root = await projectRoot();
    const outside = path.join(path.dirname(root), 'outside.svg');
    await writeFile(outside, '<svg>secret</svg>');
    roots.push(outside);
    await fixture(
      root,
      't3.json',
      JSON.stringify({ iconPath: '../outside.svg' }),
    );

    expect(await readProjectIcon(root)).toBeUndefined();
  });
});
