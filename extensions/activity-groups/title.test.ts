import { describe, expect, it } from 'vitest';
import {
  composeTitle,
  derivePastTense,
  isNarration,
  stripEmphasis,
  toPastTense,
} from './title';
import { IRREGULAR_PAST_TENSE } from './verbs';

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
    expect(toPastTense('Finding the leak')).toBe('Found the leak');
    expect(toPastTense('Splitting the module')).toBe('Split the module');
  });

  it('derives everything regular, including what looks irregular', () => {
    expect(toPastTense('Aligning the columns')).toBe('Aligned the columns');
    expect(toPastTense('Modifying the parser')).toBe('Modified the parser');
    // "-ing" already doubled the consonant and the past tense keeps it.
    expect(toPastTense('Inferring conventions')).toBe('Inferred conventions');
    expect(toPastTense('Committing the fix')).toBe('Committed the fix');
    expect(toPastTense('Clarifying the rule')).toBe('Clarified the rule');
  });

  it('conjugates both halves of a header that names two things', () => {
    expect(toPastTense('Verifying the scratch edit and cleaning up')).toBe(
      'Verified the scratch edit and cleaned up',
    );
    expect(toPastTense('Fixing the leak and rerunning the suite')).toBe(
      'Fixed the leak and reran the suite',
    );
    // Only a participle is a verb: "and" joins two nouns just as often.
    expect(toPastTense('Reading the parser and the tests')).toBe(
      'Read the parser and the tests',
    );
  });

  it('completes common Russian narration in the masculine form', () => {
    expect(toPastTense('Сравниваю реализации')).toBe('Сравнил реализации');
    expect(toPastTense('Разбираю обработчик')).toBe('Разобрал обработчик');
    expect(toPastTense('Реализую поддержку')).toBe('Реализовал поддержку');
    expect(toPastTense('Просматриваю изменения')).toBe('Просмотрел изменения');
    expect(toPastTense('Закрепляю поведение тестом')).toBe(
      'Закрепил поведение тестом',
    );
    expect(toPastTense('сравниваю реализации')).toBe('сравнил реализации');
  });

  it('covers observed and common coding-agent phases', () => {
    const cases = [
      ['Оркестрирую задачи', 'Оркестрировал задачи'],
      ['Возвращаю результат', 'Вернул результат'],
      ['Записываю решение', 'Записал решение'],
      ['Коммичу исправление', 'Закоммитил исправление'],
      ['Откладываю эксперимент', 'Отложил эксперимент'],
      ['Сделаю итоговую проверку', 'Сделал итоговую проверку'],
      ['Сканирую сессии', 'Просканировал сессии'],
      ['Расширяю словарь', 'Расширил словарь'],
      ['Сверяю результаты', 'Сверил результаты'],
      ['Формирую отчёт', 'Сформировал отчёт'],
    ] as const;
    for (const [present, past] of cases)
      expect(toPastTense(present)).toBe(past);
  });

  it('completes actions at the start of later sentences and clauses', () => {
    expect(toPastTense("There's an issue here. Fixing it")).toBe(
      "There's an issue here. Fixed it",
    );
    expect(toPastTense('There is an issue. Fixing it')).toBe(
      'There was an issue. Fixed it',
    );
    expect(toPastTense('The parser leaks; Fixing its cleanup')).toBe(
      'The parser leaks; Fixed its cleanup',
    );
    expect(toPastTense('Есть проблема. Исправляю обработчик')).toBe(
      'Есть проблема. Исправил обработчик',
    );
  });

  it('conjugates Russian actions joined by и', () => {
    expect(toPastTense('Проверяю изменения и запускаю тесты')).toBe(
      'Проверил изменения и запустил тесты',
    );
  });

  // The table existed alongside 36 rows the rule below already produced. Each
  // row costs a reader a lookup, so it has to earn one: keeping this honest is
  // cheaper than re-deriving the whole table the next time one is added.
  it('lists nothing the regular rule already gets right', () => {
    const derivable = Object.entries(IRREGULAR_PAST_TENSE)
      .filter(([participle, past]) => derivePastTense(participle) === past)
      .map(([participle]) => participle);
    expect(derivable).toEqual([]);
  });

  it('leaves anything that is not a participle alone', () => {
    expect(toPastTense('Quick fix for shutdown')).toBe(
      'Quick fix for shutdown',
    );
    expect(toPastTense('')).toBe('');
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
    expect(composeTitle(['Сравниваю API', 'Сравниваю тесты'])).toBe(
      'Сравнил API',
    );
  });

  it('composes Russian planning and repeated implementation phases', () => {
    expect(
      composeTitle([
        'Планирую поддержку русского языка',
        'Реализую T1',
        'Реализую T2',
      ]),
    ).toBe('Спланировал и реализовал поддержку русского языка');
  });

  it('keeps both subjects in a two-part Russian group', () => {
    expect(
      composeTitle([
        'Планирую преобразование заголовков',
        'Реализую русский словарь',
      ]),
    ).toBe(
      'Спланировал преобразование заголовков и реализовал русский словарь',
    );
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
    ).toBe('Planned the shutdown fix and fixed the race');
  });

  it('keeps what each half of a two-part group was done to', () => {
    expect(
      composeTitle([
        'Planning temporary activity',
        'Creating disposable notes',
      ]),
    ).toBe('Planned temporary activity and created disposable notes');
  });

  it('falls back to one subject when the title would run long', () => {
    expect(
      composeTitle([
        'Planning the migration of every session store in the repository',
        'Rewriting the expiry handling that all of them share',
      ]),
    ).toBe(
      'Planned and rewrote the migration of every session store in the repository',
    );
  });

  it('borrows a subject when the opening header is bare', () => {
    expect(composeTitle(['Investigating', 'Fixing the deadlock'])).toBe(
      'Investigated the deadlock',
    );
  });

  it('survives narration that is only a verb', () => {
    expect(composeTitle(['Debugging'])).toBe('Debugged');
  });

  it('does not splice two narration languages into one title', () => {
    expect(
      composeTitle(['Планирую русский словарь', 'Implementing tests']),
    ).toBe('Спланировал русский словарь');
    expect(composeTitle(['Planning the dictionary', 'Реализую тесты'])).toBe(
      'Planned the dictionary',
    );
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
