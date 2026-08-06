import { Value } from 'typebox/value';
import { describe, expect, test } from 'vitest';
import {
  asToolSchema,
  captureDelegateResultEvent,
  getDelegateResultSpec,
  getSettledDelegateResult,
  normalizeDelegateResultSpec,
  projectStructuredResult,
  STRUCTURED_RESULT_CAPS,
  setDelegateResultSpec,
  settleDelegateResult,
  validateStructuredResult,
} from './structured-result';
import { createRun } from './types';

describe('schema-driven delegate results', () => {
  const schema = {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1 },
            severity: { type: 'string', enum: ['high', 'low'] },
            evidence: { type: 'string' },
          },
          required: ['title', 'severity', 'evidence'],
        },
      },
      summary: { type: 'string' },
    },
    required: ['findings', 'summary'],
  };

  test('normalizes closed schemas and projects four findings without evidence', () => {
    const spec = normalizeDelegateResultSpec({
      schema,
      projection: ['/findings/*/title', '/findings/*/severity'],
      views: { evidence: '/findings/*/evidence' },
    });
    expect(spec?.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    if (!spec) throw new Error('expected normalized result spec');
    const result = {
      findings: [
        { title: 'one', severity: 'high', evidence: 'SECRET-1' },
        { title: 'two', severity: 'low', evidence: 'SECRET-2' },
        { title: 'three', severity: 'high', evidence: 'SECRET-3' },
        { title: 'four', severity: 'low', evidence: 'SECRET-4' },
      ],
      summary: 'all',
    };
    const checked = validateStructuredResult(spec, result);
    expect(checked.valid).toBe(true);
    const projection = projectStructuredResult(spec, checked.value);
    expect(projection.value).toEqual({
      findings: [
        { title: 'one', severity: 'high' },
        { title: 'two', severity: 'low' },
        { title: 'three', severity: 'high' },
        { title: 'four', severity: 'low' },
      ],
    });
    expect(JSON.stringify(projection.value)).not.toContain('SECRET');
  });

  test('rejects unsupported keywords and bounded schemas before launch', () => {
    expect(() =>
      normalizeDelegateResultSpec({
        schema: { type: 'string', pattern: '.*' },
      }),
    ).toThrow(/Unsupported result schema keyword/);
    expect(() =>
      normalizeDelegateResultSpec({
        schema: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from(
              { length: STRUCTURED_RESULT_CAPS.maxProperties + 1 },
              (_, i) => [`p${i}`, { type: 'string' }],
            ),
          ),
        },
      }),
    ).toThrow(/property limit/);
    expect(() =>
      normalizeDelegateResultSpec({
        schema: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
        },
        projection: ['/0'],
      }),
    ).toThrow(/declared|array/);
  });

  test('omits an overflowing projection without leaking its selected value', () => {
    const spec = normalizeDelegateResultSpec({
      schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { secret: { type: 'string' } },
            },
          },
        },
        required: ['items'],
      },
      projection: ['/items/*/secret'],
    });
    if (!spec) throw new Error('expected normalized result spec');
    const secret = `private-${'x'.repeat(4088)}`;
    const result = { items: Array.from({ length: 3 }, () => ({ secret })) };
    const checked = validateStructuredResult(spec, result);
    expect(checked.valid).toBe(true);
    const projection = projectStructuredResult(spec, checked.value);
    expect(projection.value).toBeUndefined();
    expect(projection.omittedPaths).toEqual(['/items/*/secret']);
    expect(JSON.stringify(projection.value ?? null)).not.toContain('private-');
  });

  test('rejects escaping and invalid wildcard projection paths', () => {
    expect(() =>
      normalizeDelegateResultSpec({
        schema: {
          type: 'object',
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
        projection: ['/items/0'],
      }),
    ).toThrow(/declared|array/);
    expect(() =>
      normalizeDelegateResultSpec({
        schema: {
          type: 'object',
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
        projection: ['/items/../secret'],
      }),
    ).toThrow(/escaping/);
    expect(() =>
      normalizeDelegateResultSpec({
        schema: { type: 'object', properties: { item: { type: 'string' } } },
        projection: ['/*/item'],
      }),
    ).toThrow(/array/);
  });

  test('reports missing, extra, wrong-type, enum, and byte-limit failures', () => {
    const spec = normalizeDelegateResultSpec({ schema });
    if (!spec) throw new Error('expected normalized result spec');
    expect(
      validateStructuredResult(spec, { findings: [], summary: 'x' }).valid,
    ).toBe(false);
    expect(
      validateStructuredResult(spec, {
        findings: [
          { title: 'x', severity: 'medium', evidence: 'e', extra: 'bad' },
        ],
        summary: 'x',
      }).errors.join('\n'),
    ).toMatch(/enum|additional/);
    const long = '🙂'.repeat(STRUCTURED_RESULT_CAPS.maxStringLength + 1);
    expect(
      validateStructuredResult(spec, {
        findings: [{ title: long, severity: 'high', evidence: 'e' }],
        summary: 'x',
      }).valid,
    ).toBe(false);
  });

  test.each([
    ['missing', [] as const],
    ['multiple', [1, 2] as const],
  ])('rejects a %s delegate_result channel', (_label, calls) => {
    const spec = normalizeDelegateResultSpec({
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    if (!spec) throw new Error('expected normalized result spec');
    const run = createRun('channel');
    setDelegateResultSpec(run, spec);
    for (let index = 0; index < calls.length; index++)
      captureDelegateResultEvent(run, { details: { ok: true } }, false);
    const settled = settleDelegateResult(run);
    expect(settled?.valid).toBe(false);
    expect(settled?.errors.join('; ')).toMatch(
      calls.length === 0 ? /missing/ : /exactly once.*2/,
    );
  });

  test('uses the child TypeBox contract for decimal multipleOf settlement', () => {
    const spec = normalizeDelegateResultSpec({
      schema: { type: 'number', multipleOf: 0.1 },
    });
    if (!spec) throw new Error('expected normalized result spec');
    const childSchema = asToolSchema(spec.schema);
    for (const value of [0.3, 0.30000000000000004]) {
      expect(Value.Check(childSchema, value)).toBe(
        validateStructuredResult(spec, value).valid,
      );
      expect(validateStructuredResult(spec, value).valid).toBe(true);
    }
    expect(Value.Check(childSchema, 0.31)).toBe(
      validateStructuredResult(spec, 0.31).valid,
    );
    expect(validateStructuredResult(spec, 0.31).valid).toBe(false);
  });

  test('captures only tool details and makes malformed settlement non-success', () => {
    const spec = normalizeDelegateResultSpec({
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
    });
    const run = createRun('structured');
    setDelegateResultSpec(run, spec);
    captureDelegateResultEvent(run, { details: { ok: 'wrong' } }, false);
    const settled = settleDelegateResult(run);
    expect(settled?.valid).toBe(false);
    expect(run.state).toBe('error');
    expect(JSON.stringify(run)).not.toContain('wrong');
    expect(getSettledDelegateResult(run)?.errors[0]).toContain('/ok');
    expect(getDelegateResultSpec(run)).toBe(spec);
  });
});
