#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA_VERSION = 'session-metrics/v3';
const METRIC_KEYS = [
  'userTurns',
  'assistantTurns',
  'todoToolCalls',
  'todoToolResults',
  'compactions',
  'elapsedMs',
  'usageInput',
  'usageOutput',
  'usageCacheRead',
  'usageCacheWrite',
  'peakRequestContext',
  'delegateToolCalls',
  'delegateContinuationCalls',
  'delegateParallelCalls',
  'delegateRejectedCalls',
  'delegatedTasks',
  'delegateWritableTasks',
  'delegateTruncatedTasks',
  'delegateHandoffBytes',
  'delegateBackgroundJobsLaunched',
  'delegateBackgroundRunsLaunched',
  'delegateBackgroundDeliveries',
  'delegateEscalatedCalls',
  'delegateDeescalatedCalls',
  'delegateOutcomeDone',
  'delegateOutcomePartial',
  'delegateOutcomeBlocked',
  'delegateOutcomeFailed',
  'delegateOutcomeUnreported',
  'delegateProcessErrors',
  'delegateProcessTimeouts',
  'delegateProcessAborts',
  'delegateArtifactReferences',
  'delegateArtifactFallbacks',
  'delegateWorktreeReturns',
  'routedTasks',
  'childTurns',
  'childUsageInput',
  'childUsageOutput',
  'childCost',
];

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Derived measurements, computed the same way for one session and for a cohort
 * so a cohort ratio is never a mean of per-session ratios.
 */
const RATIO_KEYS = {
  cacheHitRatio: (m) =>
    ratio(
      m.usageCacheRead,
      m.usageInput + m.usageCacheRead + m.usageCacheWrite,
    ),
  delegateHandoffBytesPerTask: (m) =>
    ratio(m.delegateHandoffBytes, m.delegatedTasks),
  delegateTruncationRate: (m) =>
    ratio(m.delegateTruncatedTasks, m.delegatedTasks),
  delegateContinuationRate: (m) =>
    ratio(m.delegateContinuationCalls, m.delegateToolCalls),
  // Of the calls that resumed earlier work, the share that needed a costlier
  // route to do it. High means the first route is being picked too cheaply.
  delegateEscalationRate: (m) =>
    ratio(m.delegateEscalatedCalls, m.delegateContinuationCalls),
  // Child spend is only comparable to executions whose routing record also
  // carried usage. Legacy runs and repeated report deliveries are excluded.
  childTurnsPerTask: (m) => ratio(m.childTurns, m.routedTasks),
  childCostPerTask: (m) => ratio(m.childCost, m.routedTasks),
};

function withRatios(metrics) {
  for (const [key, compute] of Object.entries(RATIO_KEYS))
    metrics[key] = compute(metrics);
  return metrics;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toolCalls(message, name) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content))
    return [];
  return message.content.filter(
    (part) => part?.type === 'toolCall' && part.name === name,
  );
}

/** Tool arguments are usually decoded already; some providers leave them as JSON text. */
function toolArguments(call) {
  const raw = call?.arguments;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/** The acknowledgement a background delegate call returns in place of a report. */
const BACKGROUND_START_MARKER = /^Started \d+ background delegate job/;
/** How a finished background job hands its report to the parent. */
const BACKGROUND_DELIVERY_MARKER =
  /^#?\s*Background delegate job (\S+) .*?\n\n(Delegated tasks?\b[\s\S]*)$/;
/** Separates the jobs when several finish together and are delivered as one. */
const BACKGROUND_DELIVERY_SEPARATOR = '\n\n---\n\n';
/** Leads every handoff, and says how many runs it covers. */
const HANDOFF_HEADER = /^Delegated tasks: \d+\/(\d+) succeeded/;

/** Counts an execution once; its report may be pushed and later peeked again. */
function recordExecution(state, runs, ids, text = '', indicators = true) {
  const outcomes = reportedOutcomes(text);
  for (let index = 0; index < runs.length; index += 1) {
    const id = ids[index];
    const run = runs[index] ?? {};
    if (state.executedRuns.has(id)) {
      if (indicators) recordRunIndicators(state, run, id, outcomes[index]);
      continue;
    }
    state.executedRuns.add(id);
    state.metrics.delegatedTasks += 1;
    if (run.allowWrites === true) state.metrics.delegateWritableTasks += 1;
    if (indicators) recordRunIndicators(state, run, id, outcomes[index]);
  }
}

/** Handoff copies cost context every time, but never create another execution. */
function recordBackgroundDelivery(state, text, jobs = []) {
  const byId = new Map(
    jobs
      .filter((job) => typeof job?.id === 'string')
      .map((job) => [job.id, job]),
  );
  for (const segment of text.split(BACKGROUND_DELIVERY_SEPARATOR)) {
    const delivered = segment.match(BACKGROUND_DELIVERY_MARKER);
    if (!delivered) continue;
    const [, jobId, handoff] = delivered;
    const header = handoff.match(HANDOFF_HEADER);
    const taskCount = header ? Number(header[1]) : 1;
    const runs = Array.isArray(byId.get(jobId)?.runs)
      ? byId.get(jobId).runs
      : Array.from({ length: taskCount }, () => ({}));
    const ids = runs.map((_, index) => `${jobId}:${index}`);
    state.metrics.delegateBackgroundDeliveries += 1;
    state.metrics.delegateHandoffBytes += Buffer.byteLength(handoff, 'utf8');
    state.metrics.delegateArtifactFallbacks += countOccurrences(
      handoff,
      'Exact output artifact unavailable',
    );
    recordTruncatedTasks(state, ids, handoff);
    // A completion can be retained after its launch entry is absent from the
    // active ancestry. Stable per-job identities make either path count once.
    recordExecution(state, runs, ids, handoff);
    recordRouting(state, runs, ids);
  }
}

/** Emitted once per run envelope by the current delegate build. */
const TRUNCATED_MARKER = 'Truncation: body truncated';
/** The marker older handoffs left inline, before the envelope carried the flag. */
const LEGACY_TRUNCATED_MARKER = '[Output truncated for parent context';

function countOccurrences(text, marker) {
  return text.split(marker).length - 1;
}

/** A repeated pushed/peeked handoff must not inflate a unique-task rate. */
function recordTruncatedTasks(state, ids, text) {
  const truncated =
    countOccurrences(text, TRUNCATED_MARKER) ||
    countOccurrences(text, LEGACY_TRUNCATED_MARKER);
  for (const id of ids.slice(0, truncated)) {
    if (state.truncatedRuns.has(id)) continue;
    state.truncatedRuns.add(id);
    state.metrics.delegateTruncatedTasks += 1;
  }
}

function resultText(message) {
  return (Array.isArray(message.content) ? message.content : [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/**
 * Counts what a delegate result cost the parent and how many tasks it covers.
 * `details.runs` is authoritative: a call rejected for invalid parameters comes
 * back as a delegate tool result with no runs, and counting it as a delegated
 * task would understate the bytes every real task spends.
 */
function backgroundJobIds(text) {
  const matched = text.match(/^Started \d+ background delegate jobs?: ([^.]+)/);
  return matched ? matched[1].split(', ').filter(Boolean) : [];
}

function recordDelegateResult(state, message, executionNumber) {
  const { metrics } = state;
  const runs = Array.isArray(message.details?.runs) ? message.details.runs : [];
  if (runs.length === 0) {
    metrics.delegateRejectedCalls += 1;
    return { runs, background: false };
  }
  const text = resultText(message);
  const background = BACKGROUND_START_MARKER.test(text);
  if (message.details?.mode === 'parallel') metrics.delegateParallelCalls += 1;
  if (background) {
    const jobIds = backgroundJobIds(text);
    metrics.delegateBackgroundJobsLaunched += jobIds.length || runs.length;
    metrics.delegateBackgroundRunsLaunched += runs.length;
    recordExecution(
      state,
      runs,
      runs.map(
        (run, index) =>
          `${run?.backgroundJobId ?? jobIds[index] ?? `launch:${executionNumber}:${index}`}:0`,
      ),
      '',
      false,
    );
    return { runs, background: true };
  }
  const ids = runs.map((_, index) => `foreground:${executionNumber}:${index}`);
  recordExecution(state, runs, ids, text);
  metrics.delegateHandoffBytes += Buffer.byteLength(text, 'utf8');
  metrics.delegateArtifactFallbacks += countOccurrences(
    text,
    'Exact output artifact unavailable',
  );
  recordTruncatedTasks(state, ids, text);
  return { runs, background: false };
}

/** Per-route counters, created on first sight so absent routes stay absent. */
function routeBucket(routes, name) {
  routes[name] ??= {
    tasks: 0,
    turns: 0,
    usageInput: 0,
    usageOutput: 0,
    cost: 0,
    relativeCost: 0,
  };
  return routes[name];
}

/**
 * What a child actually spent, charged to the route that ran it. Usage lives on
 * the run rather than in the child's own session file, so this needs only the
 * parent transcript. A run is recorded once: background jobs are keyed by id, so
 * a job that is delivered and then peeked at does not bill its route twice —
 * unlike handoff bytes, the child ran only once however often it is reported.
 */
function reportedOutcomes(text) {
  return [
    ...text.matchAll(/^Outcome:\s*(done|partial|blocked|failed)\b/gim),
  ].map((match) => match[1].toLowerCase());
}

function recordRunIndicators(state, run, id, outcome) {
  if (state.indicatedRuns.has(id)) return;
  state.indicatedRuns.add(id);
  if (outcome)
    state.metrics[
      `delegateOutcome${outcome[0].toUpperCase()}${outcome.slice(1)}`
    ] += 1;
  else state.metrics.delegateOutcomeUnreported += 1;
  if (run?.artifact) state.metrics.delegateArtifactReferences += 1;
  if (run?.worktree) state.metrics.delegateWorktreeReturns += 1;
  if (run?.state === 'timed-out' || run?.exitCode === 124)
    state.metrics.delegateProcessTimeouts += 1;
  else if (run?.state === 'aborted' || run?.stopReason === 'aborted')
    state.metrics.delegateProcessAborts += 1;
  else if (
    run?.state === 'error' ||
    run?.stopReason === 'error' ||
    (typeof run?.exitCode === 'number' && run.exitCode > 0)
  )
    state.metrics.delegateProcessErrors += 1;
}

function hasRoutingUsage(usage) {
  return ['turns', 'input', 'output', 'cost'].some(
    (key) => finiteNumber(usage?.[key]) !== 0,
  );
}

function recordRouting(state, runs, ids) {
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const routing = run?.routing;
    if (typeof run?.continuation === 'string' && routing)
      state.routeByContinuation.set(
        run.continuation,
        finiteNumber(routing.relativeCost),
      );
    const usage = run?.usage ?? {};
    // A route name without recorded usage is not an executed routing sample.
    if (
      !routing ||
      typeof routing.route !== 'string' ||
      !hasRoutingUsage(usage)
    )
      continue;
    const id = ids[index];
    if (state.billedRuns.has(id)) continue;
    state.billedRuns.add(id);
    const bucket = routeBucket(state.routes, routing.route);
    bucket.tasks += 1;
    bucket.turns += finiteNumber(usage.turns);
    bucket.usageInput += finiteNumber(usage.input);
    bucket.usageOutput += finiteNumber(usage.output);
    bucket.cost += finiteNumber(usage.cost);
    bucket.relativeCost = finiteNumber(routing.relativeCost);
    state.metrics.routedTasks += 1;
    state.metrics.childTurns += finiteNumber(usage.turns);
    state.metrics.childUsageInput += finiteNumber(usage.input);
    state.metrics.childUsageOutput += finiteNumber(usage.output);
    state.metrics.childCost += finiteNumber(usage.cost);
  }
}

/**
 * Whether resuming a task moved it to a costlier route. The parent is told what
 * fell short, never which route to use, so a move here is the parent's own
 * judgement about the first choice — which makes the rate a read on routing
 * quality rather than on the children.
 */
function recordEscalation(state, runs) {
  const continuations = state.pendingContinuationCalls.shift() ?? [];
  const comparisons = continuations
    .map(({ token, index }) => {
      const before = state.routeByContinuation.get(token);
      const routing = runs[index]?.routing;
      return before === undefined || !routing
        ? undefined
        : { before, after: finiteNumber(routing.relativeCost) };
    })
    .filter((comparison) => comparison !== undefined);
  if (comparisons.length === 0) return;
  // Calls remain the unit, but task positions ensure a fresh parallel task
  // cannot change the route comparison for a resumed sibling.
  const before = Math.max(
    ...comparisons.map((comparison) => comparison.before),
  );
  const after = Math.max(...comparisons.map((comparison) => comparison.after));
  if (after > before) state.metrics.delegateEscalatedCalls += 1;
  if (after < before) state.metrics.delegateDeescalatedCalls += 1;
}

/** Continuation tokens paired with their result position, single or parallel. */
function continuationEntries(call) {
  const args = toolArguments(call);
  const tasks = Array.isArray(args.tasks) ? args.tasks : [];
  if (tasks.length)
    return tasks.flatMap((task, index) =>
      typeof task?.continuation === 'string'
        ? [{ token: task.continuation, index }]
        : [],
    );
  return typeof args.continuation === 'string'
    ? [{ token: args.continuation, index: 0 }]
    : [];
}

function activeAncestry(entries) {
  const byId = new Map(
    entries
      .filter((entry) => typeof entry.id === 'string')
      .map((entry) => [entry.id, entry]),
  );
  let current = entries.findLast(
    (entry) => entry.type !== 'session' && typeof entry.id === 'string',
  );
  const active = [];
  const visited = new Set();
  while (current && !visited.has(current.id)) {
    active.push(current);
    visited.add(current.id);
    current =
      typeof current.parentId === 'string'
        ? byId.get(current.parentId)
        : undefined;
  }
  return active.reverse();
}

export function parseSessionJsonl(source) {
  const lines = source.split(/\r?\n/);
  const entries = [];
  let malformedLines = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value))
        entries.push(value);
      else malformedLines += 1;
    } catch {
      malformedLines += 1;
    }
  }

  const active = activeAncestry(entries);
  const metrics = Object.fromEntries(METRIC_KEYS.map((key) => [key, 0]));
  const state = {
    metrics,
    routes: {},
    executedRuns: new Set(),
    indicatedRuns: new Set(),
    billedRuns: new Set(),
    truncatedRuns: new Set(),
    routeByContinuation: new Map(),
    pendingContinuationCalls: [],
  };
  let delegateResultNumber = 0;
  const timestamps = [];
  for (const entry of active) {
    const timestamp = Date.parse(entry.timestamp ?? entry.message?.timestamp);
    if (Number.isFinite(timestamp)) timestamps.push(timestamp);
    if (entry.type === 'compaction') metrics.compactions += 1;
    // A finished background job is pushed to the parent as a steering message,
    // outside the tool-result stream its `delegate` call belonged to.
    if (entry.customType === 'delegate-job-result')
      recordBackgroundDelivery(
        state,
        entry.content ?? '',
        entry.details?.jobs ?? [],
      );
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message?.role === 'user') metrics.userTurns += 1;
    if (message?.role === 'assistant') {
      metrics.assistantTurns += 1;
      metrics.todoToolCalls += toolCalls(message, 'todo').length;
      const delegated = toolCalls(message, 'delegate');
      metrics.delegateToolCalls += delegated.length;
      metrics.delegateContinuationCalls += delegated.filter(
        (call) => continuationEntries(call).length > 0,
      ).length;
      for (const call of delegated)
        state.pendingContinuationCalls.push(continuationEntries(call));
      const usage = message.usage ?? {};
      metrics.usageInput += finiteNumber(usage.input);
      metrics.usageOutput += finiteNumber(usage.output);
      metrics.usageCacheRead += finiteNumber(usage.cacheRead);
      metrics.usageCacheWrite += finiteNumber(usage.cacheWrite);
      metrics.peakRequestContext = Math.max(
        metrics.peakRequestContext,
        finiteNumber(usage.input) +
          finiteNumber(usage.cacheRead) +
          finiteNumber(usage.cacheWrite),
      );
    }
    if (message?.role === 'toolResult' && message.toolName === 'todo')
      metrics.todoToolResults += 1;
    if (message?.role === 'toolResult' && message.toolName === 'delegate') {
      const result = recordDelegateResult(
        state,
        message,
        delegateResultNumber++,
      );
      recordEscalation(state, result.runs);
      if (!result.background)
        recordRouting(
          state,
          result.runs,
          result.runs.map(
            (_, index) => `foreground:${delegateResultNumber - 1}:${index}`,
          ),
        );
    }
    if (message?.role === 'toolResult' && message.toolName === 'delegate_jobs')
      recordBackgroundDelivery(
        state,
        resultText(message),
        message.details?.jobs ?? [],
      );
  }
  if (timestamps.length > 1)
    metrics.elapsedMs = Math.max(...timestamps) - Math.min(...timestamps);

  return {
    sessionId: createHash('sha256').update(source).digest('hex').slice(0, 12),
    ...withRatios(metrics),
    routes: state.routes,
    malformedLines,
  };
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Route buckets merged across sessions. Kept beside the numeric totals rather
 * than inside them: `compare` subtracts totals key by key, and a route present
 * in one cohort and absent from the other has no meaningful difference.
 */
function mergeRoutes(sessions) {
  const routes = {};
  for (const session of sessions)
    for (const [name, bucket] of Object.entries(session.routes ?? {})) {
      const target = routeBucket(routes, name);
      for (const [key, value] of Object.entries(bucket))
        target[key] = key === 'relativeCost' ? value : target[key] + value;
    }
  return Object.fromEntries(
    Object.entries(routes).sort((a, b) => b[1].tasks - a[1].tasks),
  );
}

export function aggregateSessions(sessions) {
  const totals = Object.fromEntries(METRIC_KEYS.map((key) => [key, 0]));
  totals.malformedLines = 0;
  for (const session of sessions) {
    for (const key of METRIC_KEYS) totals[key] += session[key];
    totals.malformedLines += session.malformedLines;
  }
  withRatios(totals);
  const medians = Object.fromEntries(
    [...METRIC_KEYS, ...Object.keys(RATIO_KEYS), 'malformedLines'].map(
      (key) => [key, median(sessions.map((session) => session[key]))],
    ),
  );
  return {
    sessionCount: sessions.length,
    totals,
    medians,
    routes: mergeRoutes(sessions),
  };
}

async function discover(input) {
  const absolute = resolve(input);
  const info = await stat(absolute);
  if (info.isFile()) return absolute.endsWith('.jsonl') ? [absolute] : [];
  if (!info.isDirectory()) return [];
  const children = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(
    children
      .filter(
        (child) =>
          child.isDirectory() ||
          (child.isFile() && child.name.endsWith('.jsonl')),
      )
      .map((child) => discover(`${absolute}/${child.name}`)),
  );
  return nested.flat();
}

export async function summarizePaths(inputs, options = {}) {
  const discovered = (await Promise.all(inputs.map(discover))).flat();
  const files = [...new Set(discovered)].sort();
  const sessions = [];
  for (const file of files) {
    const session = parseSessionJsonl(await readFile(file, 'utf8'));
    if (
      session.todoToolCalls >= (options.minTodoCalls ?? 0) &&
      session.delegateToolCalls >= (options.minDelegateCalls ?? 0)
    )
      sessions.push(session);
  }
  const limited =
    options.limit === undefined ? sessions : sessions.slice(0, options.limit);
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'summary',
    sessions: limited,
    cohort: aggregateSessions(limited),
  };
}

function subtract(comparison, baseline) {
  return Object.fromEntries(
    Object.keys(comparison).map((key) => [
      key,
      comparison[key] - baseline[key],
    ]),
  );
}

export function compareSummaries(baseline, comparison) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'comparison',
    baseline: { sessions: baseline.sessions ?? [], ...baseline.cohort },
    comparison: {
      sessions: comparison.sessions ?? [],
      ...comparison.cohort,
    },
    deltas: {
      sessionCount:
        comparison.cohort.sessionCount - baseline.cohort.sessionCount,
      totals: subtract(comparison.cohort.totals, baseline.cohort.totals),
      medians: subtract(comparison.cohort.medians, baseline.cohort.medians),
    },
  };
}

function usage() {
  return 'Usage: session-metrics summarize <file|dir>... [--limit N] [--min-todo-calls N] [--min-delegate-calls N]\n       session-metrics compare --baseline <file|dir> [--baseline ...] --comparison <file|dir> [--comparison ...] [--limit N] [--min-todo-calls N] [--min-delegate-calls N]';
}

function positiveInteger(value, flag, allowZero = false) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1))
    throw new Error(`Invalid ${flag}`);
  return parsed;
}

export async function runCli(args) {
  const [command, ...rest] = args;
  let limit;
  let minTodoCalls = 0;
  let minDelegateCalls = 0;
  const plain = [];
  const baseline = [];
  const comparison = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--limit') limit = positiveInteger(rest[++index], arg);
    else if (arg === '--min-todo-calls')
      minTodoCalls = positiveInteger(rest[++index], arg, true);
    else if (arg === '--min-delegate-calls')
      minDelegateCalls = positiveInteger(rest[++index], arg, true);
    else if (arg === '--baseline') baseline.push(rest[++index]);
    else if (arg === '--comparison') comparison.push(rest[++index]);
    else if (arg?.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else plain.push(arg);
  }
  const options = { limit, minTodoCalls, minDelegateCalls };
  if (
    command === 'summarize' &&
    plain.length > 0 &&
    baseline.length === 0 &&
    comparison.length === 0
  ) {
    return summarizePaths(plain, options);
  }
  if (
    command === 'compare' &&
    plain.length === 0 &&
    baseline.length > 0 &&
    comparison.length > 0
  ) {
    return compareSummaries(
      await summarizePaths(baseline, options),
      await summarizePaths(comparison, options),
    );
  }
  throw new Error(usage());
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runCli(process.argv.slice(2))
    .then((result) =>
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    )
    .catch((error) => {
      const isArgumentError = /^(Usage:|Invalid --|Unknown option:)/.test(
        error.message,
      );
      process.stderr.write(
        `${isArgumentError ? error.message : 'Unable to read session inputs.'}\n`,
      );
      process.exitCode = 1;
    });
}
