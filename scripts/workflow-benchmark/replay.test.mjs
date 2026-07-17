import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { compare } from './core.mjs';
import { loadCommandSpec, runSuite } from './runner.mjs';
import { SCENARIOS } from './scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('executable workflow replay', () => {
  test('executes every required synthetic repository scenario reproducibly', async () => {
    const control = await loadCommandSpec(
      path.join(here, 'fixtures', 'control.json'),
    );
    const candidate = await loadCommandSpec(
      path.join(here, 'fixtures', 'candidate.json'),
    );
    const [controlRuns, candidateRuns, repeatedCandidate] = await Promise.all([
      runSuite(control),
      runSuite(candidate),
      runSuite(candidate),
    ]);
    expect(candidateRuns.runs.map((run) => run.scenarioId)).toEqual(SCENARIOS);
    expect(candidateRuns).toEqual(repeatedCandidate);
    expect(candidateRuns.runs.every((run) => run.completed)).toBe(true);
    expect(candidateRuns.runs.every((run) => run.validationPassed)).toBe(true);
    expect(candidateRuns.runs.every((run) => run.statePreserved)).toBe(true);
    const report = compare(controlRuns, candidateRuns);
    expect(report.safetyGatePassed).toBe(true);
    expect(report.delta.repeatReads).toBeLessThan(0);
    expect(report.delta.repeatStatuses).toBeLessThan(0);
  }, 30_000);
});
