#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { compare } from './core.mjs';
import { loadCommandSpec, runSuite } from './runner.mjs';
import { SCENARIOS } from './scenarios.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const controlPath = argument('--control');
const candidatePath = argument('--candidate');
const outputPath = argument('--output');
const timeoutValue = argument('--timeout-ms');
const timeoutMs = timeoutValue === undefined ? undefined : Number(timeoutValue);
const sequential = process.argv.includes('--sequential');
const scenarioValue = argument('--scenarios');
const scenarios = scenarioValue?.split(',').filter(Boolean);
if (!controlPath || !candidatePath) {
  console.error(
    'Usage: node scripts/workflow-benchmark/index.mjs --control control.json --candidate candidate.json [--output report.json] [--timeout-ms 180000] [--sequential] [--scenarios clean-edit,...]',
  );
  process.exit(64);
}

if (
  scenarios &&
  (scenarios.length === 0 ||
    scenarios.some((item) => !SCENARIOS.includes(item)))
) {
  console.error(`--scenarios must contain only: ${SCENARIOS.join(',')}`);
  process.exit(64);
}
if (
  timeoutMs !== undefined &&
  (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000)
) {
  console.error('--timeout-ms must be an integer from 1000 to 900000');
  process.exit(64);
}

try {
  const [controlSpec, candidateSpec] = await Promise.all([
    loadCommandSpec(controlPath),
    loadCommandSpec(candidatePath),
  ]);
  let control;
  let candidate;
  if (sequential) {
    control = await runSuite(controlSpec, { timeoutMs, scenarios });
    candidate = await runSuite(candidateSpec, { timeoutMs, scenarios });
  } else {
    [control, candidate] = await Promise.all([
      runSuite(controlSpec, { timeoutMs, scenarios }),
      runSuite(candidateSpec, { timeoutMs, scenarios }),
    ]);
  }
  const report = compare(control, candidate);
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, rendered, 'utf8');
  else process.stdout.write(rendered);
  if (!report.safetyGatePassed) process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
