export const SCHEMA_VERSION = 'workflow-benchmark/v1';

const numericFields = [
  'userInterventions',
  'avoidableQuestions',
  'toolCalls',
  'repeatReads',
  'repeatStatuses',
  'elapsedMs',
  'uncachedInput',
  'cacheRead',
  'cacheWrite',
  'output',
  'peakContext',
  'delegateCostUsd',
  'capabilityViolations',
];

function finite(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error(`${field} must be a non-negative finite number`);
  return value;
}

export function validateDataset(dataset) {
  if (!dataset || dataset.schemaVersion !== SCHEMA_VERSION)
    throw new Error(`Expected schemaVersion ${SCHEMA_VERSION}`);
  const datasetKeys = Object.keys(dataset);
  const unknownDatasetKeys = datasetKeys.filter(
    (key) => !['schemaVersion', 'label', 'runs'].includes(key),
  );
  if (unknownDatasetKeys.length > 0)
    throw new Error(
      `Unknown dataset fields are prohibited: ${unknownDatasetKeys.join(', ')}`,
    );
  if (
    typeof dataset.label !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(dataset.label)
  )
    throw new Error(
      'label must be a safe lowercase identifier (letters, digits, dot, underscore, hyphen)',
    );
  if (!Array.isArray(dataset.runs) || dataset.runs.length === 0)
    throw new Error('runs must be a non-empty array');
  return {
    schemaVersion: SCHEMA_VERSION,
    label: dataset.label,
    runs: dataset.runs.map((run, index) => {
      if (!run || typeof run !== 'object')
        throw new Error(`runs[${index}] must be an object`);
      const allowed = new Set([
        'scenarioId',
        'completed',
        'validationPassed',
        'statePreserved',
        ...numericFields,
      ]);
      const unknown = Object.keys(run).filter((key) => !allowed.has(key));
      if (unknown.length > 0)
        throw new Error(
          `runs[${index}] contains prohibited or unknown fields: ${unknown.join(', ')}`,
        );
      if (
        typeof run.scenarioId !== 'string' ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(run.scenarioId)
      )
        throw new Error(`runs[${index}].scenarioId is invalid`);
      for (const field of ['completed', 'validationPassed', 'statePreserved'])
        if (typeof run[field] !== 'boolean')
          throw new Error(`runs[${index}].${field} must be a boolean`);
      const normalized = {
        scenarioId: run.scenarioId,
        completed: run.completed,
        validationPassed: run.validationPassed,
        statePreserved: run.statePreserved,
      };
      for (const field of numericFields) {
        if (!(field in run))
          throw new Error(`runs[${index}].${field} is required`);
        normalized[field] = finite(run[field], `runs[${index}].${field}`);
      }
      return normalized;
    }),
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarize(dataset) {
  const normalized = validateDataset(dataset);
  const runs = normalized.runs;
  const scenarioIds = runs.map((run) => run.scenarioId);
  if (new Set(scenarioIds).size !== scenarioIds.length)
    throw new Error('scenarioId values must be unique within a dataset');
  const summary = {
    schemaVersion: SCHEMA_VERSION,
    label: normalized.label,
    runCount: runs.length,
    completionRate: mean(runs.map((run) => Number(run.completed))),
    validationRate: mean(runs.map((run) => Number(run.validationPassed))),
    statePreservationRate: mean(runs.map((run) => Number(run.statePreserved))),
  };
  for (const field of numericFields)
    summary[field] = mean(runs.map((run) => run[field]));
  summary.cacheHitRatio =
    summary.uncachedInput + summary.cacheRead > 0
      ? summary.cacheRead / (summary.uncachedInput + summary.cacheRead)
      : 0;
  return summary;
}

export function compare(controlDataset, candidateDataset) {
  const normalizedControl = validateDataset(controlDataset);
  const normalizedCandidate = validateDataset(candidateDataset);
  const controlIds = normalizedControl.runs.map((run) => run.scenarioId).sort();
  const candidateIds = normalizedCandidate.runs
    .map((run) => run.scenarioId)
    .sort();
  if (JSON.stringify(controlIds) !== JSON.stringify(candidateIds))
    throw new Error('Control and candidate scenario sets must match exactly');
  const control = summarize(normalizedControl);
  const candidate = summarize(normalizedCandidate);
  const regressions = [];
  const candidateByScenario = new Map(
    normalizedCandidate.runs.map((run) => [run.scenarioId, run]),
  );
  for (const baseline of normalizedControl.runs) {
    const next = candidateByScenario.get(baseline.scenarioId);
    if (!next) continue;
    if (baseline.completed && !next.completed)
      regressions.push(`${baseline.scenarioId}:completion`);
    if (baseline.validationPassed && !next.validationPassed)
      regressions.push(`${baseline.scenarioId}:validation`);
    if (baseline.statePreserved && !next.statePreserved)
      regressions.push(`${baseline.scenarioId}:preservation`);
    if (next.capabilityViolations > baseline.capabilityViolations)
      regressions.push(`${baseline.scenarioId}:capability-violations`);
  }
  if (candidate.completionRate < control.completionRate)
    regressions.push('completion-rate');
  if (candidate.validationRate < control.validationRate)
    regressions.push('validation-rate');
  if (candidate.capabilityViolations > control.capabilityViolations)
    regressions.push('capability-violations');
  if (candidate.statePreservationRate < control.statePreservationRate)
    regressions.push('state-preservation');
  return {
    schemaVersion: SCHEMA_VERSION,
    control,
    candidate,
    delta: Object.fromEntries(
      [
        'completionRate',
        'validationRate',
        'userInterventions',
        'avoidableQuestions',
        'toolCalls',
        'repeatReads',
        'repeatStatuses',
        'elapsedMs',
        'uncachedInput',
        'cacheHitRatio',
        'output',
        'peakContext',
        'delegateCostUsd',
        'capabilityViolations',
        'statePreservationRate',
      ].map((field) => [field, candidate[field] - control[field]]),
    ),
    safetyGatePassed: regressions.length === 0,
    regressions,
  };
}
