import { describe, expect, it } from 'vitest';
import {
  parsePromptArguments,
  replaceSkillReferences,
  substitutePromptArguments,
} from './composer-text.js';

describe('shared prompt syntax', () => {
  it.each<[string, string[]]>([
    ['', []],
    ['one\t two\nthree', ['one', 'two', 'three']],
    ['"src/a b.ts" \'with care\'', ['src/a b.ts', 'with care']],
    ['a"b c"d', ['ab cd']],
    ['"unfinished argument', ['unfinished argument']],
    ['"" \'\' kept', ['kept']],
  ])('parses arguments %j', (text, expected) => {
    expect(parsePromptArguments(text)).toEqual(expected);
  });

  it.each<[string, string[], string]>([
    ['$1|$2|$9', ['one', 'two'], 'one|two|'],
    ['$ARGUMENTS|$@', ['one', 'two'], 'one two|one two'],
    [`\${2:-care}`, ['one', 'two', 'three', 'four'], 'two'],
    [`\${2:-care}|\${ARGUMENTS:-none}|\${@:-none}`, ['one'], 'care|one|one'],
    [`\${1:-care}|\${ARGUMENTS:-none}|\${@:-none}`, [], 'care|none|none'],
    [
      `\${@:2}|\${@:2:1}|\${@:0:2}|\${@:9}`,
      ['one', 'two', 'three'],
      'two three|two|one two|',
    ],
    [`$unknown \${not-an-argument}`, ['one'], `$unknown \${not-an-argument}`],
  ])('substitutes %j', (template, args, expected) => {
    expect(substitutePromptArguments(template, args)).toBe(expected);
  });

  it('selects known skills once in reference order and preserves metadata', () => {
    const first = { name: 'first' };
    const second = { name: 'second' };
    expect(
      replaceSkillReferences(
        '$second $first $second $unknown',
        new Map([
          ['first', first],
          ['second', second],
        ]),
      ),
    ).toEqual({
      text: 'second first second $unknown',
      selected: [second, first],
    });
  });

  it.each<[string, string]>([
    ['\\$demo', '$demo'],
    ['`$demo` $demo', '`$demo` demo'],
    ['``$demo ` code`` $demo', '``$demo ` code`` demo'],
    ['`$demo\nstill code` $demo', '`$demo\nstill code` demo'],
    ['```ts\n$demo\n```\n$demo', '```ts\n$demo\n```\ndemo'],
    ['  ```ts\n$demo\n  ```\n$demo', '  ```ts\n$demo\n  ```\ndemo'],
    ['  ```ts\n$demo\n```\n$demo', '  ```ts\n$demo\n```\ndemo'],
    ['~~~\n$demo\n~~~\n$demo', '~~~\n$demo\n~~~\ndemo'],
    ['```\n~~~\n$demo\n```\n$demo', '```\n~~~\n$demo\n```\ndemo'],
    ['$demo-extra $demo', '$demo-extra demo'],
  ])('preserves code and escaped references in %j', (text, expected) => {
    const skill = { name: 'demo' };
    const result = replaceSkillReferences(text, new Map([['demo', skill]]));
    expect(result.text).toBe(expected);
    expect(result.selected).toEqual(text === '\\$demo' ? [] : [skill]);
  });
});
