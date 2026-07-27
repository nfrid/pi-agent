#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA_VERSION = 'session-metrics/v2';
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

/** Emitted once per run envelope by the current delegate build. */
const TRUNCATED_MARKER = 'Truncation: body truncated';
/** The marker older handoffs left inline, before the envelope carried the flag. */
const LEGACY_TRUNCATED_MARKER = '[Output truncated for parent context';

function countOccurrences(text, marker) {
  return text.split(marker).length - 1;
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
function recordDelegateResult(metrics, message) {
  const runs = Array.isArray(message.details?.runs) ? message.details.runs : [];
  if (runs.length === 0) {
    metrics.delegateRejectedCalls += 1;
    return;
  }
  const text = resultText(message);
  metrics.delegatedTasks += runs.length;
  metrics.delegateHandoffBytes += Buffer.byteLength(text, 'utf8');
  metrics.delegateWritableTasks += runs.filter(
    (run) => run?.allowWrites === true,
  ).length;
  if (message.details?.mode === 'parallel') metrics.delegateParallelCalls += 1;
  const truncated =
    countOccurrences(text, TRUNCATED_MARKER) ||
    countOccurrences(text, LEGACY_TRUNCATED_MARKER);
  metrics.delegateTruncatedTasks += Math.min(truncated, runs.length);
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
  const timestamps = [];
  for (const entry of active) {
    const timestamp = Date.parse(entry.timestamp ?? entry.message?.timestamp);
    if (Number.isFinite(timestamp)) timestamps.push(timestamp);
    if (entry.type === 'compaction') metrics.compactions += 1;
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message?.role === 'user') metrics.userTurns += 1;
    if (message?.role === 'assistant') {
      metrics.assistantTurns += 1;
      metrics.todoToolCalls += toolCalls(message, 'todo').length;
      const delegated = toolCalls(message, 'delegate');
      metrics.delegateToolCalls += delegated.length;
      metrics.delegateContinuationCalls += delegated.filter(
        (call) => typeof toolArguments(call).continuation === 'string',
      ).length;
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
    if (message?.role === 'toolResult' && message.toolName === 'delegate')
      recordDelegateResult(metrics, message);
  }
  if (timestamps.length > 1)
    metrics.elapsedMs = Math.max(...timestamps) - Math.min(...timestamps);

  return {
    sessionId: createHash('sha256').update(source).digest('hex').slice(0, 12),
    ...withRatios(metrics),
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
  return { sessionCount: sessions.length, totals, medians };
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
