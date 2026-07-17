import { describe, expect, test } from 'vitest';
import { compare, summarize, validateDataset } from './core.mjs';
import { validateEvents } from './runner.mjs';

const run = (overrides = {}) => ({
  scenarioId: 'clean-edit',
  completed: true,
  validationPassed: true,
  statePreserved: true,
  userInterventions: 1,
  avoidableQuestions: 1,
  toolCalls: 10,
  repeatReads: 2,
  repeatStatuses: 1,
  elapsedMs: 1000,
  uncachedInput: 100,
  cacheRead: 100,
  cacheWrite: 10,
  output: 50,
  peakContext: 500,
  delegateCostUsd: 1,
  capabilityViolations: 0,
  ...overrides,
});
const dataset = (label, runs) => ({
  schemaVersion: 'workflow-benchmark/v1',
  label,
  runs,
});

describe('workflow benchmark', () => {
  test('produces deterministic aggregate metrics without raw task content', () => {
    const result = summarize(
      dataset('control', [
        run(),
        run({ scenarioId: 'dirty-worktree', toolCalls: 14 }),
      ]),
    );
    expect(result.toolCalls).toBe(12);
    expect(result.cacheHitRatio).toBe(0.5);
    expect(JSON.stringify(result)).not.toContain('prompt');
  });

  test('fails the safety gate on capability or state-preservation regressions', () => {
    const result = compare(
      dataset('control', [run()]),
      dataset('candidate', [
        run({ capabilityViolations: 1, statePreserved: false }),
      ]),
    );
    expect(result.safetyGatePassed).toBe(false);
    expect(result.regressions).toContain('clean-edit:capability-violations');
    expect(result.regressions).toContain('clean-edit:preservation');
    expect(result.regressions).toContain('capability-violations');
    expect(result.regressions).toContain('state-preservation');
  });

  test('rejects malformed, nonterminal, and unknown replay events', () => {
    expect(() =>
      validateEvents([
        JSON.stringify({ seq: 1, atMs: 1, type: 'usage' }),
        JSON.stringify({ seq: 2, atMs: 2, type: 'complete' }),
      ]),
    ).toThrow(/invalid fields/);
    expect(() =>
      validateEvents([
        JSON.stringify({ seq: 1, atMs: 1, type: 'complete' }),
        JSON.stringify({ seq: 2, atMs: 2, type: 'complete' }),
      ]),
    ).toThrow(/exactly one terminal/);
    expect(() =>
      validateEvents([
        JSON.stringify({
          seq: 1,
          atMs: 1,
          type: 'complete',
          privatePrompt: 'must not pass',
        }),
      ]),
    ).toThrow(/unknown fields/);
  });

  test('rejects malformed or negative aggregate input', () => {
    expect(() => validateDataset({ schemaVersion: 'old', runs: [] })).toThrow();
    expect(() =>
      validateDataset(dataset('bad', [run({ elapsedMs: -1 })])),
    ).toThrow(/elapsedMs/);
    expect(() =>
      validateDataset(dataset('raw', [run({ prompt: 'private' })])),
    ).toThrow(/prohibited/);
    expect(() =>
      validateDataset(dataset('private task description', [run()])),
    ).toThrow(/label/);
    expect(() =>
      compare(
        dataset('control', [run()]),
        dataset('candidate', [run({ scenarioId: 'other' })]),
      ),
    ).toThrow(/scenario sets/);
    const incomplete = run();
    delete incomplete.statePreserved;
    expect(() => validateDataset(dataset('incomplete', [incomplete]))).toThrow(
      /statePreserved/,
    );
  });
});
