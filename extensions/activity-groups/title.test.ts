import { describe, expect, it } from 'vitest';
import { isNarration, stripEmphasis } from './title';

describe('isNarration', () => {
  it('recognises a header the model wrote as text rather than thinking', () => {
    expect(isNarration('**Creating a throwaway experiment fixture**')).toBe(
      true,
    );
    expect(isNarration('## Reading the auth code\n')).toBe(true);
  });

  it('leaves anything actually addressed to the user alone', () => {
    expect(isNarration('The leak is in the shutdown path.')).toBe(false);
    // A header with prose under it is a message, not a label for the calls.
    expect(
      isNarration('**Summary**\n\nThe token never expires, which is the bug.'),
    ).toBe(false);
    expect(isNarration('   ')).toBe(false);
  });
});

describe('stripEmphasis', () => {
  it('unwraps markdown a title would otherwise print as punctuation', () => {
    expect(stripEmphasis("Now I'll check **how sessions expire**")).toBe(
      "Now I'll check how sessions expire",
    );
    expect(stripEmphasis('Fixing the `resolveVerification` call')).toBe(
      'Fixing the resolveVerification call',
    );
  });

  it('leaves lone markers alone, since paths wear them too', () => {
    expect(stripEmphasis('Reading src/*.ts and __init__.py')).toBe(
      'Reading src/*.ts and __init__.py',
    );
  });
});
