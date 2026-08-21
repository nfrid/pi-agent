import { describe, expect, it } from 'vitest';
import { expandHomePath } from './projects.js';

describe('expandHomePath', () => {
  it('expands the home shorthand without changing other paths', () => {
    expect(expandHomePath('~', '/Users/test')).toBe('/Users/test');
    expect(expandHomePath('~/code/project', '/Users/test')).toBe(
      '/Users/test/code/project',
    );
    expect(expandHomePath('/tmp/project', '/Users/test')).toBe('/tmp/project');
    expect(expandHomePath('~other/project', '/Users/test')).toBe(
      '~other/project',
    );
  });
});
