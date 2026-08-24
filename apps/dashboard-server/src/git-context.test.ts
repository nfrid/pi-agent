import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readGitContext } from './git-context.js';

describe('live Git context', () => {
  it('fails clearly for a non-Git project', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'dashboard-git-context-'),
    );
    try {
      await expect(readGitContext(directory)).rejects.toThrow(
        'Git context unavailable',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
