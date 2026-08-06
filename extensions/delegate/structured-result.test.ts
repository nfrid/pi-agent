import { describe, expect, test } from 'vitest';
import {
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
