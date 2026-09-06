import { describe, expect, it } from 'vitest';
import { queryViaCodexAppServer } from './index.js';

describe('Codex app-server transport', () => {
  it('rejects instead of crashing when codex is unavailable', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(
        queryViaCodexAppServer(new AbortController().signal),
      ).rejects.toThrow(/Could not start codex app-server|ENOENT/);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
