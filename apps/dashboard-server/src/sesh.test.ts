import { describe, expect, it } from 'vitest';
import { normalizeSeshEntries } from './sesh.js';

describe('Sesh normalization', () => {
  it('accepts installed capitalized JSON and merges duplicate paths', () => {
    const result = normalizeSeshEntries(
      [
        { Src: 'tmux', Name: 'project', Path: '/tmp/project' },
        { Src: 'zoxide', Name: 'Project duplicate', Path: '/tmp/project' },
      ],
      ['project'],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      path: '/tmp/project',
      canonicalPath: '/tmp/project',
      tmuxSession: 'project',
      active: true,
    });
  });

  it('does not infer inactive tmux sessions from a Sesh row', () => {
    expect(
      normalizeSeshEntries([
        { Src: 'tmux', Name: 'dormant', Path: '/tmp/dormant' },
      ])[0]?.active,
    ).toBe(false);
  });
});
