import { describe, expect, it } from 'vitest';
import {
  classifyDisposition,
  classifyDispositionDetail,
  hasUnresolvedToolFailure,
} from './episodes.mjs';
import { parseSessionJsonl } from './index.mjs';

function lines(values) {
  return values.map((value) => JSON.stringify(value)).join('\n');
}

function transcript(build) {
  const values = [
    { type: 'session', id: 'session', timestamp: '2026-01-01T00:00:00.000Z' },
  ];
  let parentId = null;
  let sequence = 0;
  const time = () =>
    `2026-01-01T00:00:${String(++sequence).padStart(2, '0')}.000Z`;
  const user = (content) => {
    const id = `u-${sequence}`;
    values.push({
      type: 'message',
      id,
      parentId,
      timestamp: time(),
      message: { role: 'user', content },
    });
    parentId = id;
  };
  const tool = (name, argumentsValue, { error = false } = {}) => {
    const assistantId = `a-${sequence}`;
    const resultId = `r-${sequence}`;
    const toolCallId = `c-${sequence}`;
    values.push({
      type: 'message',
      id: assistantId,
      parentId,
      timestamp: time(),
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: toolCallId, name, arguments: argumentsValue },
        ],
      },
    });
    values.push({
      type: 'message',
      id: resultId,
      parentId: assistantId,
      timestamp: time(),
      message: {
        role: 'toolResult',
        toolCallId,
        toolName: name,
        isError: error,
        content: error ? 'failed' : 'ok',
        ...(name === 'delegate'
          ? { details: argumentsValue.details ?? { runs: [] } }
          : {}),
      },
    });
    parentId = resultId;
  };
  const answer = (content) => {
    const id = `a-${sequence}`;
    values.push({
      type: 'message',
      id,
      parentId,
      timestamp: time(),
      message: { role: 'assistant', content },
    });
    parentId = id;
  };
  build({ user, tool, answer, values });
  return lines(values);
}

function sameTimestampBurst(calls, reaction = 'Looks good') {
  const values = [
    { type: 'session', id: 'session', timestamp: '2026-01-01T00:00:00.000Z' },
    {
      type: 'message',
      id: 'u-1',
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: 'Do the work' },
    },
  ];
  const assistantId = 'a-burst';
  values.push({
    type: 'message',
    id: assistantId,
    parentId: 'u-1',
    timestamp: '2026-01-01T00:00:02.000Z',
    message: {
      role: 'assistant',
      content: calls.map(({ name, args }, index) => ({
        type: 'toolCall',
        id: `burst-call-${index}`,
        name,
        arguments: args,
      })),
    },
  });
  let parentId = assistantId;
  calls.forEach(({ name }, index) => {
    const resultId = `burst-result-${index}`;
    values.push({
      type: 'message',
      id: resultId,
      parentId,
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'toolResult',
        toolCallId: `burst-call-${index}`,
        toolName: name,
        content: 'ok',
      },
    });
    parentId = resultId;
  });
  values.push({
    type: 'message',
    id: 'a-answer',
    parentId,
    timestamp: '2026-01-01T00:00:03.000Z',
    message: { role: 'assistant', content: 'Done.' },
  });
  values.push({
    type: 'message',
    id: 'u-reaction',
    parentId: 'a-answer',
    timestamp: '2026-01-01T00:00:04.000Z',
    message: { role: 'user', content: reaction },
  });
  return lines(values);
}

describe('deterministic bilingual disposition classification', () => {
  it.each([
    ['I approve this.', 'accepted'],
    ['Looks good, but it still fails.', 'revise'],
    ['Please implement it and run the tests.', 'advance'],
    ['What must I approve before we proceed?', 'inquiry'],
    ['одобряю', 'accepted'],
    ['одобрено', 'accepted'],
    ['годится', 'accepted'],
    ['приступайте', 'advance'],
    ['продолжайте, коммитьте и пушьте', 'advance'],
    ['всё ещё не работает, исправь', 'revise'],
    ['по-хорошему это надо обсудить', 'unknown'],
    ['lgtm, коммит и пуш', 'accepted'],
    ['The result is correct', 'accepted'],
    ['No errors now, looks good', 'accepted'],
    ['The fix is correct.', 'accepted'],
    ['This fix works as expected.', 'accepted'],
    ['The change works.', 'accepted'],
    ['Looks good, but I reject this.', 'unknown'],
    ['No errors, but I disagree.', 'unknown'],
    ['No errors, but I do not approve this.', 'unknown'],
    ['Everything is correct.', 'unknown'],
    ['The result is correct, please fix it', 'revise'],
    ['Looks good, but please fix the code.', 'revise'],
    ['Please fix it.', 'revise'],
    ['The fix is wrong; please repair it.', 'revise'],
    ['Если тест упадет, исправь', 'unknown'],
    ['Не одобряю это', 'unknown'],
  ])('classifies %s as %s', (text, expected) => {
    expect(classifyDisposition(text)).toBe(expected);
  });

  it('reports mixed and unknown language without retaining text', () => {
    expect(classifyDispositionDetail('LGTM, коммит и пуш')).toEqual({
      disposition: 'accepted',
      language: 'mixed',
    });
    expect(classifyDispositionDetail('???')).toEqual({
      disposition: 'unknown',
      language: 'unknown',
    });
  });
});

describe('retry-aware session episode facets', () => {
  it('uses exact and corrected intent identity like activity groups', () => {
    let nextId = 0;
    const tool = (name, args, isError, status = 'complete') => ({
      type: 'tool',
      id: `${name}-${++nextId}`,
      name,
      args,
      isError,
      status,
    });
    expect(
      hasUnresolvedToolFailure([
        tool('edit', { path: 'src/a.ts', oldText: 'old' }, true),
        tool('edit', { path: 'src/a.ts', oldText: 'new' }, false),
      ]),
    ).toBe(false);
    expect(
      hasUnresolvedToolFailure([
        tool('bash', { command: 'npm run lint' }, true),
        tool('bash', { command: 'npm test' }, false),
      ]),
    ).toBe(true);
  });

  it('derives a completed todo episode, immediate acceptance, and observed verification', () => {
    const source = transcript(({ user, tool, answer }) => {
      user('Implement the change');
      tool('todo', {
        action: 'replace',
        tasks: [{ id: 'T1', text: 'PRIVATE TASK', status: 'todo' }],
      });
      tool('write', { path: '/private/repo/file.ts', content: 'SECRET' });
      tool('bash', { command: 'npm run test' });
      tool('todo', { action: 'done', id: 'T1' });
      answer('Finished.');
      user('Looks good');
    });
    const parsed = parseSessionJsonl(source, { includeEpisodes: true });
    expect(parsed.episodes).toHaveLength(1);
    expect(parsed.episodes[0]).toMatchObject({
      ordinal: 1,
      plan: 'all-done',
      operational: 'inferred-settled',
      shape: 'mutation-validated',
      disposition: 'accepted',
      observedVerification: true,
      validation: { status: 'passed', attempts: { test: 1 } },
    });
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).not.toContain('/private/repo');
    expect(serialized).not.toContain('SECRET');
  });

  it('keeps a blocked todo plan censored', () => {
    const source = transcript(({ user, tool, answer }) => {
      user('Work on this');
      tool('todo', {
        action: 'replace',
        tasks: [{ id: 'T1', text: 'hidden', status: 'blocked' }],
      });
      answer('I am blocked.');
    });
    const parsed = parseSessionJsonl(source, { includeEpisodes: true });
    expect(parsed.episodes[0]).toMatchObject({
      plan: 'blocked-censored',
      operational: 'inferred-settled',
      disposition: 'unknown',
    });
  });

  it('classifies the immediate inquiry and does not skip to later approval', () => {
    const source = transcript(({ user, tool, answer }) => {
      user('Finish this');
      tool('todo', {
        action: 'replace',
        tasks: [{ id: 'T1', text: 'hidden', status: 'todo' }],
      });
      tool('todo', { action: 'done', id: 'T1' });
      answer('Finished.');
      user('What changed?');
      answer('The implementation.');
      user('Looks good');
    });
    const parsed = parseSessionJsonl(source, { includeEpisodes: true });
    expect(parsed.episodes[0]).toMatchObject({
      disposition: 'inquiry',
      language: 'english',
    });
    expect(parsed.episodes[1]).toMatchObject({
      plan: 'absent',
      disposition: 'accepted',
    });
  });

  it('distinguishes dropped, mixed, removed, and superseded epochs', () => {
    const source = transcript(({ user, tool, answer }) => {
      user('Do planned work');
      tool('todo', { action: 'replace', tasks: [{ id: 'T1', text: 'x' }] });
      tool('todo', { action: 'drop', id: 'T1' });
      answer('Dropped.');
      user('Start again');
      tool('todo', {
        action: 'replace',
        tasks: [
          { id: 'T1', text: 'x', status: 'todo' },
          { id: 'T2', text: 'y', status: 'done' },
        ],
      });
      tool('todo', { action: 'remove', id: 'T1' });
      answer('Removed.');
      user('New plan');
      tool('todo', { action: 'replace', tasks: [{ id: 'T3', text: 'z' }] });
      tool('todo', { action: 'replace', tasks: [{ id: 'T4', text: 'w' }] });
      answer('Superseded.');
    });
    const parsed = parseSessionJsonl(source, { includeEpisodes: true });
    expect(parsed.episodes.map((episode) => episode.plan)).toEqual([
      'dropped-only',
      'removed',
      'superseded',
      'active-censored',
    ]);
  });

  it('falls back to an agent run without inventing a plan', () => {
    const source = transcript(({ user, tool, answer }) => {
      user('Answer without a todo');
      tool('read', { path: '/private/repo/file.ts' });
      answer('Done.');
      user('Approved');
    });
    const parsed = parseSessionJsonl(source, { includeEpisodes: true });
    expect(parsed.episodes[0]).toMatchObject({
      plan: 'absent',
      shape: 'analysis-only',
      operational: 'inferred-settled',
      disposition: 'accepted',
    });
    expect(parsed.episodeCohorts.byShape['analysis-only'].episodeCount).toBe(1);
  });

  it('tracks validation retries, stale validation, and delivery facets', () => {
    const source = transcript(({ user, tool, answer }) => {
      user('Make and deliver the change');
      tool('write', { path: 'src/a.ts', content: 'one' });
      tool('bash', { command: 'npm run lint' }, { error: true });
      tool('bash', { command: 'npm run lint' });
      tool('bash', { command: 'npm test' });
      tool('write', { path: 'src/a.ts', content: 'two' });
      tool('bash', { command: 'git commit -am update' });
      answer('Done.');
      user('Please fix it');
    });
    const parsed = parseSessionJsonl(source, { includeEpisodes: true });
    expect(parsed.episodes[0]).toMatchObject({
      validation: {
        status: 'stale-after-later-mutation',
        retries: { lint: 1 },
      },
      delivery: { commitAttempts: 1, commitSuccesses: 1 },
      mutation: { successful: 2, finalMutationValidated: false },
      disposition: 'revise',
    });
    expect(parsed.episodes[0].shape).toBe('mutation-unvalidated');
  });

  it('does not erase a failed lint with an unrelated successful test', () => {
    const source = transcript(({ user, tool, answer }) => {
      user('Validate the change');
      tool('write', { path: 'src/a.ts', content: 'change' });
      tool('bash', { command: 'npm run lint' }, { error: true });
      tool('bash', { command: 'npm test' });
      answer('Done.');
    });
    const episode = parseSessionJsonl(source, { includeEpisodes: true })
      .episodes[0];
    expect(episode.validation).toMatchObject({
      status: 'failed',
      retries: { lint: 0, test: 0 },
    });
  });

  it('counts retries independently for every validation kind', () => {
    const source = transcript(({ user, tool, answer }) => {
      user('Validate all checks');
      tool('write', { path: 'src/a.ts', content: 'change' });
      tool('bash', { command: 'npm run lint && npm test' }, { error: true });
      tool('bash', { command: 'npm run lint' });
      answer('Done.');
    });
    const episode = parseSessionJsonl(source, { includeEpisodes: true })
      .episodes[0];
    expect(episode.validation).toMatchObject({
      attempts: { lint: 2, test: 1 },
      retries: { lint: 1, test: 0 },
      status: 'failed',
    });
  });

  it('requires a later explicit validation for aggregate correction', () => {
    const before = transcript(({ user, tool, answer }) => {
      user('Validate the change');
      tool('write', { path: 'src/a.ts', content: 'change' });
      tool('bash', { command: 'npm run lint' });
      tool('bash', { command: 'npm run check' }, { error: true });
      answer('Done.');
    });
    expect(
      parseSessionJsonl(before, { includeEpisodes: true }).episodes[0]
        .validation.aggregateToExplicitCorrection,
    ).toBe(false);

    const after = transcript(({ user, tool, answer }) => {
      user('Validate the change');
      tool('write', { path: 'src/a.ts', content: 'change' });
      tool('bash', { command: 'npm run check' }, { error: true });
      tool('bash', { command: 'npm run lint' });
      answer('Done.');
    });
    expect(
      parseSessionJsonl(after, { includeEpisodes: true }).episodes[0].validation
        .aggregateToExplicitCorrection,
    ).toBe(true);
  });

  it('uses call order when mutation and validation share a timestamp', () => {
    const source = sameTimestampBurst([
      { name: 'write', args: { path: 'src/a.ts', content: 'change' } },
      { name: 'bash', args: { command: 'npm test' } },
    ]);
    expect(
      parseSessionJsonl(source, { includeEpisodes: true }).episodes[0],
    ).toMatchObject({
      operational: 'inferred-settled',
      observedVerification: true,
      shape: 'mutation-validated',
      mutation: { finalMutationValidated: true },
      validation: { status: 'passed' },
    });
  });

  it('assigns same-entry todo calls to deterministic epoch boundaries', () => {
    const source = sameTimestampBurst([
      {
        name: 'todo',
        args: {
          action: 'replace',
          tasks: [{ id: 'T1', status: 'todo' }],
        },
      },
      { name: 'write', args: { path: 'src/a.ts', content: 'change' } },
      { name: 'bash', args: { command: 'npm test' } },
      { name: 'todo', args: { action: 'done', id: 'T1' } },
      {
        name: 'todo',
        args: {
          action: 'replace',
          tasks: [{ id: 'T2', status: 'todo' }],
        },
      },
    ]);
    const episodes = parseSessionJsonl(source, {
      includeEpisodes: true,
    }).episodes;
    expect(episodes.map((episode) => episode.plan)).toEqual([
      'all-done',
      'active-censored',
    ]);
    expect(episodes[0]).toMatchObject({
      mutation: { successful: 1 },
      validation: { attempts: { test: 1 } },
    });
    expect(episodes[1]).toMatchObject({
      mutation: { successful: 0 },
      validation: { attempts: { test: 0 } },
    });
  });

  it('does not settle timeout followed only by another failed delegate', () => {
    const source = transcript(({ user, tool, answer }) => {
      user('Recover timed-out work');
      tool('delegate', {
        details: { runs: [{ state: 'timed-out', exitCode: 124 }] },
      });
      tool(
        'delegate',
        { details: { runs: [{ state: 'error', exitCode: 1 }] } },
        { error: true },
      );
      answer('Unable to recover.');
    });
    expect(
      parseSessionJsonl(source, { includeEpisodes: true }).episodes[0],
    ).toMatchObject({
      operational: 'timed-out',
      recovery: { delegateProviderFailures: 2, reachedSettled: false },
    });
  });

  it('keeps delegate timeout as a failure facet after parent recovery', () => {
    const source = transcript(({ user, tool, answer }) => {
      user('Recover timed-out work');
      tool('delegate', {
        details: { runs: [{ state: 'timed-out', exitCode: 124 }] },
      });
      tool('write', { path: 'src/a.ts', content: 'change' });
      tool('bash', { command: 'npm test' });
      answer('Recovered.');
      user('Looks good');
    });
    expect(
      parseSessionJsonl(source, { includeEpisodes: true }).episodes[0],
    ).toMatchObject({
      operational: 'inferred-settled',
      observedVerification: true,
      recovery: { delegateProviderFailures: 1, reachedSettled: true },
    });
  });

  it('separates unknown reactions from missing reactions in denominators', () => {
    const source = transcript(({ user, tool, answer }) => {
      user('First task');
      tool('read', { path: 'src/a.ts' });
      answer('Done.');
      user('???');
      user('Second task');
      tool('read', { path: 'src/b.ts' });
      answer('Done.');
    });
    const cohort = parseSessionJsonl(source, { includeEpisodes: true })
      .episodeCohorts.all;
    expect(cohort).toMatchObject({
      unknownDisposition: 1,
      unknownDispositionDenominator: 1,
      missingDisposition: 1,
    });
  });

  it('connects delegate/provider failure to parent recovery and verification', () => {
    const source = transcript(({ user, tool, answer }) => {
      user('Recover this work');
      tool('delegate', {
        details: {
          runs: [{ state: 'error', exitCode: 1 }],
        },
      });
      tool('write', { path: 'src/a.ts', content: 'change' });
      tool('bash', { command: 'npm test' });
      answer('Recovered.');
      user('отлично');
    });
    const parsed = parseSessionJsonl(source, { includeEpisodes: true });
    expect(parsed.episodes[0]).toMatchObject({
      operational: 'inferred-settled',
      observedVerification: true,
      recovery: {
        delegateProviderFailures: 1,
        parentTurnsAfterFailure: 3,
        parentToolCallsAfterFailure: 2,
        reachedSettled: true,
        reachedObservedVerification: true,
      },
      disposition: 'accepted',
      language: 'russian',
    });
  });
});
