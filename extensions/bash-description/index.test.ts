import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import {
  BASH_DESCRIPTION_MAX_LENGTH,
  bashDescriptionParameters,
  createBashDescriptionToolDefinition,
  validateBashDescriptionArguments,
} from './index';

describe('bash description tool', () => {
  it('accepts bounded descriptions and rejects empty or oversized values', () => {
    expect(
      Value.Check(bashDescriptionParameters, {
        command: 'git status',
        description: 'Show the repository status',
      }),
    ).toBe(true);
    expect(
      Value.Check(bashDescriptionParameters, { command: 'git status' }),
    ).toBe(true);
    expect(
      Value.Check(bashDescriptionParameters, {
        command: 'git status',
        description: '',
      }),
    ).toBe(false);
    expect(
      Value.Check(bashDescriptionParameters, {
        command: 'git status',
        description: 'x'.repeat(BASH_DESCRIPTION_MAX_LENGTH + 1),
      }),
    ).toBe(false);
    expect(
      Value.Check(bashDescriptionParameters, {
        command: 'git status',
        description: 42,
      }),
    ).toBe(false);
  });

  it('keeps the upstream prompt contribution and strips description for execution', async () => {
    const definition = createBashDescriptionToolDefinition();
    expect(definition.promptSnippet).toBe(
      'Execute bash commands (ls, grep, find, etc.)',
    );
    expect(definition.promptGuidelines).toContain(
      'You can inspect PI_* environment variables for current model and session details.',
    );

    const result = await definition.execute(
      'call-1',
      { command: 'printf compatibility', description: 'Print compatibility' },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        sessionManager: {
          getSessionId: () => 'session-1',
          getSessionFile: () => undefined,
        },
      } as never,
    );
    expect(result.content).toEqual([{ type: 'text', text: 'compatibility' }]);
  });

  it('retains a provider-compatible upstream object schema', () => {
    expect(bashDescriptionParameters).toMatchObject({
      type: 'object',
      properties: {
        command: expect.any(Object),
        timeout: expect.any(Object),
        description: expect.any(Object),
      },
      required: ['command'],
    });
    expect(bashDescriptionParameters).not.toHaveProperty('allOf');
    expect(
      Value.Check(bashDescriptionParameters, {
        command: 'printf ok',
        timeout: 2,
        description: 'Print a short result',
      }),
    ).toBe(true);
  });

  it('rejects coercible and blank descriptions before command execution', () => {
    const definition = createBashDescriptionToolDefinition();
    expect(() =>
      definition.prepareArguments?.({ command: 'false', description: 42 }),
    ).toThrow(/description must be a string.*omit it/u);
    expect(() =>
      validateBashDescriptionArguments({
        command: 'false',
        description: '   ',
      }),
    ).toThrow(/description must not be blank.*omit it/u);
    expect(() =>
      definition.prepareArguments?.({
        command: 'false',
        description: 'x'.repeat(BASH_DESCRIPTION_MAX_LENGTH + 1),
      }),
    ).toThrow(/description must be 140 characters or fewer/u);

    const converted = { command: 'false', description: 42 };
    Value.Convert(bashDescriptionParameters, converted);
    expect(converted.description).toBe('42');
  });
});
