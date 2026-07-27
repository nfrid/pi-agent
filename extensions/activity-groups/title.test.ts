import { describe, expect, it } from 'vitest';
import { composeTitle, isNarration, toPastTense } from './title';

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

describe('toPastTense', () => {
  it('uses the table for irregulars', () => {
    expect(toPastTense('Writing the shim')).toBe('Wrote the shim');
    expect(toPastTense('Running the suite')).toBe('Ran the suite');
    expect(toPastTense('Reading jobs.ts')).toBe('Read jobs.ts');
  });

  it('derives the regular forms the table cannot enumerate', () => {
    expect(toPastTense('Aligning the columns')).toBe('Aligned the columns');
    expect(toPastTense('Modifying the parser')).toBe('Modified the parser');
    // "-ing" already doubled the consonant and the past tense keeps it.
    expect(toPastTense('Inferring conventions')).toBe('Inferred conventions');
  });

  it('leaves anything that is not a participle alone', () => {
    expect(toPastTense('Quick fix for shutdown')).toBe(
      'Quick fix for shutdown',
    );
    expect(toPastTense('')).toBe('');
  });
});

describe('composeTitle', () => {
  it('joins how a group opened with what it spent itself on', () => {
    expect(
      composeTitle([
        'Planning the activity groups rework',
        'Implementing T1',
        'Implementing T2 and T3',
        'Implementing T4',
      ]),
    ).toBe('Planned and implemented the activity groups rework');
  });

  it('does not repeat the verb when the group never changed register', () => {
    expect(
      composeTitle(['Inspecting authentication code', 'Inspecting the tests']),
    ).toBe('Inspected authentication code');
  });

  it('names the group for real work rather than the intent it announced', () => {
    // "Planning" is said twice and "Fixing" once, but planning is not what a
    // group is *for* — the dominant verb is picked from the work.
    expect(
      composeTitle([
        'Planning the shutdown fix',
        'Planning the rollout',
        'Fixing the race',
      ]),
    ).toBe('Planned and fixed the shutdown fix');
  });

  it('borrows a subject when the opening header is bare', () => {
    expect(composeTitle(['Investigating', 'Fixing the deadlock'])).toBe(
      'Investigated the deadlock',
    );
  });

  it('survives narration that is only a verb', () => {
    expect(composeTitle(['Debugging'])).toBe('Debugged');
  });

  it('takes a header that is not a sentence at its word', () => {
    // Models label sections as often as they narrate actions, and reading the
    // first word of one as a verb gave "Planned and 1. fresh context retrieval".
    expect(composeTitle(['1. Fresh context retrieval'])).toBe(
      '1. Fresh context retrieval',
    );
    expect(
      composeTitle(['Planning the rollout', '1. Fresh context retrieval']),
    ).toBe('Planned the rollout');
  });

  it('has nothing to say without narration', () => {
    expect(composeTitle([])).toBeUndefined();
  });
});
