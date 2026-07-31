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
