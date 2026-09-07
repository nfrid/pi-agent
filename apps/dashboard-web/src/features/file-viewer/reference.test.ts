import { describe, expect, it } from 'vitest';
import { parseFileReference } from './reference';

describe('file references', () => {
  it.each([
    ['src/file.ts:123', 'src/file.ts', 123, 123],
    ['src/file.ts:123-145', 'src/file.ts', 123, 145],
    ['file.ts:2', 'file.ts', 2, 2],
    ['./file.ts#L2-L8', './file.ts', 2, 8],
    ['/Users/nfrid/file.ts#L2', '/Users/nfrid/file.ts', 2, 2],
    ['~/some%20file.md:1-3', '~/some file.md', 1, 3],
  ])('parses %s', (href, path, startLine, endLine) => {
    expect(parseFileReference(href, { cwd: '/child' })).toEqual({
      path,
      cwd: '/child',
      startLine,
      endLine,
    });
  });

  it('preserves origin context and resolves same-document heading destinations', () => {
    expect(
      parseFileReference('../README.md#some-heading', { cwd: '/project/docs' }),
    ).toEqual({
      path: '../README.md',
      cwd: '/project/docs',
      heading: 'some-heading',
    });
    expect(
      parseFileReference('#hello%20world', {
        cwd: '/project',
        path: '/project/README.md',
      }),
    ).toEqual({
      path: '/project/README.md',
      cwd: '/project',
      heading: 'hello world',
    });
    expect(parseFileReference('#heading')).toBeUndefined();
    expect(parseFileReference('LICENSE')).toEqual({ path: 'LICENSE' });
  });

  it.each([
    'https://example.com/file.ts:123',
    'mailto:a@b.test',
    '//example.com/file',
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/passwd',
    'javascript%3Aalert(1)',
    '%2F%2Fexample.com/file',
    'foo%00.ts',
    'bad%zz',
    '~another/file',
    'file.ts:0',
    'file.ts:5-2',
    'file.ts#L0',
    'file.ts:9007199254740993',
    '',
  ])('does not treat %s as an actionable file reference', (href) => {
    expect(parseFileReference(href)).toBeUndefined();
  });
});
