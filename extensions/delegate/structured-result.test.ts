import { Value } from 'typebox/value';
import { describe, expect, test } from 'vitest';
import { getDelegateLifecycle } from './lifecycle';
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

  test('expands compact shapes into the same closed bounded schema', () => {
    const spec = normalizeDelegateResultSpec({
      shape: {
        outcome: ['done', 'partial', 'blocked'],
        summary: {
          $optional: { $type: 'string', minLength: 1, maxLength: 500 },
        },
        findings: [
          {
            title: 'string',
            severity: ['low', 'medium', 'high'],
            tags: [['string', 'security']],
          },
        ],
      },
      projection: ['/outcome', '/findings/*/title'],
    });
    if (!spec) throw new Error('expected normalized result spec');
    expect(spec.schema).toMatchObject({
      type: 'object',
      required: ['findings', 'outcome'],
      additionalProperties: false,
      properties: {
        outcome: {
          type: 'string',
          enum: ['done', 'partial', 'blocked'],
        },
        summary: { type: 'string', minLength: 1, maxLength: 500 },
        findings: {
          type: 'array',
          maxItems: STRUCTURED_RESULT_CAPS.maxArrayItems,
          items: {
            type: 'object',
            required: ['severity', 'tags', 'title'],
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              severity: { type: 'string', enum: ['low', 'medium', 'high'] },
              tags: {
                type: 'array',
                items: { type: 'string', enum: ['string', 'security'] },
              },
            },
          },
        },
      },
    });
    expect(
      validateStructuredResult(spec, {
        outcome: 'done',
        findings: [{ title: 'fixed', severity: 'high', tags: ['security'] }],
      }).valid,
    ).toBe(true);
  });

  test('rejects ambiguous or invalid compact result shapes', () => {
    expect(() => normalizeDelegateResultSpec({})).toThrow(/exactly one/);
    expect(() =>
      normalizeDelegateResultSpec({
        schema: { type: 'string' },
        shape: 'string',
      }),
    ).toThrow(/exactly one/);
    expect(() =>
      normalizeDelegateResultSpec({ shape: { value: ['yes', false] } }),
    ).toThrow(/one JSON type/);
    expect(() =>
      normalizeDelegateResultSpec({
        shape: { value: { $optional: { $optional: 'string' } } },
      }),
    ).toThrow(/cannot be nested/);
    expect(() =>
      normalizeDelegateResultSpec({ shape: { $private: 'string' } }),
    ).toThrow(/reserved/);
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

  test('aligns numeric object paths while rejecting array indexes and full-result views', () => {
    const numericObject = normalizeDelegateResultSpec({
      schema: {
        type: 'object',
        properties: {
          '0': { type: 'string' },
          items: { type: 'array', items: { type: 'string' } },
        },
      },
      views: { numeric: '/0' },
    });
    expect(numericObject?.views).toEqual({ numeric: '/0' });
    expect(() =>
      normalizeDelegateResultSpec({
        schema: {
          type: 'object',
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
        views: { indexed: '/items/0' },
      }),
    ).toThrow(/declared|array/);
    expect(() =>
      normalizeDelegateResultSpec({
        schema: { type: 'object', properties: { secret: { type: 'string' } } },
        views: { complete: '/' },
      }),
    ).toThrow(/complete result/);
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

  test('turns deeply nested sub-64KiB JSON into bounded validation errors', () => {
    let value: unknown = null;
    for (let index = 0; index < 20_000; index++) value = [value];
    const spec = normalizeDelegateResultSpec({ schema: { type: 'null' } });
    if (!spec) throw new Error('expected normalized result spec');
    expect(() => validateStructuredResult(spec, value)).not.toThrow(RangeError);
    const result = validateStructuredResult(spec, value);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeLessThanOrEqual(
      STRUCTURED_RESULT_CAPS.maxValidationErrors,
    );
  });

  test('allows an invalid attempt to be corrected by a later valid attempt', () => {
    const spec = normalizeDelegateResultSpec({
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
    });
    if (!spec) throw new Error('expected normalized result spec');
    const run = createRun('invalid then valid');
    setDelegateResultSpec(run, spec);
    captureDelegateResultEvent(run, { details: { ok: 'wrong' } }, false);
    captureDelegateResultEvent(run, { details: { ok: true } }, false);

    expect(settleDelegateResult(run)).toEqual({
      valid: true,
      value: { ok: true },
      errors: [],
    });
  });

  test('uses the last valid attempt when delegate_result succeeds repeatedly', () => {
    const spec = normalizeDelegateResultSpec({
      schema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    });
    if (!spec) throw new Error('expected normalized result spec');
    const run = createRun('valid then valid');
    setDelegateResultSpec(run, spec);
    captureDelegateResultEvent(run, { details: { value: 'first' } }, false);
    captureDelegateResultEvent(run, { details: { value: 'last' } }, false);

    expect(settleDelegateResult(run)?.value).toEqual({ value: 'last' });
  });

  test('rejects a channel with no valid result', () => {
    const spec = normalizeDelegateResultSpec({
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    if (!spec) throw new Error('expected normalized result spec');
    const run = createRun('no valid result');
    setDelegateResultSpec(run, spec);
    captureDelegateResultEvent(run, { details: { ok: 'wrong' } }, false);
    captureDelegateResultEvent(run, {}, true);
    const settled = settleDelegateResult(run);

    expect(settled?.valid).toBe(false);
    expect(settled?.errors.join('; ')).toMatch(
      /tool execution failed.*missing or malformed/,
    );
    expect(run.state).toBe('error');
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
    run.messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'arbitrary malformed-attempt prose' }],
      },
    ] as never;
    setDelegateResultSpec(run, spec);
    captureDelegateResultEvent(run, { details: { ok: 'wrong' } }, false);
    const settled = settleDelegateResult(run);
    expect(settled?.valid).toBe(false);
    expect(run.state).toBe('error');
    expect(JSON.stringify(run)).not.toContain('wrong');
    expect(getSettledDelegateResult(run)?.errors[0]).toContain('/ok');
    expect(getDelegateResultSpec(run)).toBe(spec);
    expect(getDelegateLifecycle(run)?.diagnostic).not.toContain(
      'arbitrary malformed-attempt prose',
    );
  });
});
