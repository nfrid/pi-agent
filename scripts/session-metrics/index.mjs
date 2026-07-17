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
  'autonomyDelegateCalls',
  'autonomyDelegateInputTokens',
  'autonomyDelegateOutputTokens',
  'autonomyDelegateCostUsd',
  'autonomyBlockedAttempts',
  'autonomyPolicyDenials',
  'autonomyMissingCapabilityDenials',
  'autonomyOutsideScopeDenials',
  'autonomyUncontrolledShellDenials',
  'autonomyExpiredEnvelopeDenials',
  'autonomyInvalidTargetDenials',
  'autonomyWriteScopeDenials',
  'autonomyConfirmationDenials',
  'autonomyUnsupportedToolDenials',
  'autonomySandboxUnavailableDenials',
  'autonomyObservedViolations',
  'autonomyAutoApprovedLeases',
  'autonomyLeasedRepositories',
  'autonomyLeasedPaths',
  'autonomyInteractiveApprovals',
  'autonomyInteractiveDenials',
  'sandboxShellInspectCalls',
  'sandboxShellValidateCalls',
  'sandboxShellEditCalls',
  'sandboxShellFailures',
  'sandboxShellAppliedEdits',
  'sandboxShellRejectedEdits',
  'sandboxShellChangedPaths',
  'autonomyPatchConflicts',
];

const AUTONOMY_METRICS_TYPES = new Set([
  'workflow-autonomy-metrics:v1',
  'workflow-autonomy-metrics:v2',
]);

function applyAutonomySnapshot(metrics, data) {
  const policyDenials =
    data.policyDenials && typeof data.policyDenials === 'object'
      ? data.policyDenials
      : {};
  const values = {
    autonomyDelegateCalls: data.delegateCalls,
    autonomyDelegateInputTokens: data.delegateInputTokens,
    autonomyDelegateOutputTokens: data.delegateOutputTokens,
    autonomyDelegateCostUsd: data.delegateCostUsd,
    autonomyBlockedAttempts: data.blockedCapabilityAttempts,
    autonomyPolicyDenials: Object.values(policyDenials).reduce(
      (sum, value) => sum + finiteNumber(value),
      0,
    ),
    autonomyMissingCapabilityDenials: policyDenials['missing-capability'],
    autonomyOutsideScopeDenials: policyDenials['outside-scope'],
    autonomyUncontrolledShellDenials: policyDenials['uncontrolled-shell'],
    autonomyExpiredEnvelopeDenials: policyDenials['expired-envelope'],
    autonomyInvalidTargetDenials: policyDenials['invalid-target'],
    autonomyWriteScopeDenials: policyDenials['write-scope-required'],
    autonomyConfirmationDenials: policyDenials['confirmation-required'],
    autonomyUnsupportedToolDenials: policyDenials['unsupported-tool'],
    autonomySandboxUnavailableDenials: policyDenials['sandbox-unavailable'],
    autonomyObservedViolations: data.observedCapabilityViolations,
    autonomyAutoApprovedLeases: data.autoApprovedLeases,
    autonomyLeasedRepositories: data.leasedRepositories,
    autonomyLeasedPaths: data.leasedPaths,
    autonomyInteractiveApprovals: data.interactiveApprovals,
    autonomyInteractiveDenials: data.interactiveDenials,
    sandboxShellInspectCalls: data.sandboxShellInspectCalls,
    sandboxShellValidateCalls: data.sandboxShellValidateCalls,
    sandboxShellEditCalls: data.sandboxShellEditCalls,
    sandboxShellFailures: data.sandboxShellFailures,
    sandboxShellAppliedEdits: data.sandboxShellAppliedEdits,
    sandboxShellRejectedEdits: data.sandboxShellRejectedEdits,
    sandboxShellChangedPaths: data.sandboxShellChangedPaths,
    autonomyPatchConflicts: data.patchConflicts,
  };
  for (const [key, value] of Object.entries(values))
    metrics[key] = finiteNumber(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function todoCalls(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content))
    return 0;
  return message.content.filter(
    (part) => part?.type === 'toolCall' && part.name === 'todo',
  ).length;
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
  let autonomyMode = 'unknown';
  for (const entry of active) {
    const timestamp = Date.parse(entry.timestamp ?? entry.message?.timestamp);
    if (Number.isFinite(timestamp)) timestamps.push(timestamp);
    if (entry.type === 'compaction') metrics.compactions += 1;
    if (
      entry.type === 'custom' &&
      AUTONOMY_METRICS_TYPES.has(entry.customType) &&
      entry.data &&
      typeof entry.data === 'object'
    ) {
      applyAutonomySnapshot(metrics, entry.data);
      if (typeof entry.data.mode === 'string') autonomyMode = entry.data.mode;
    }
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message?.role === 'user') metrics.userTurns += 1;
    if (message?.role === 'assistant') {
      metrics.assistantTurns += 1;
      metrics.todoToolCalls += todoCalls(message);
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
  }
  if (timestamps.length > 1)
    metrics.elapsedMs = Math.max(...timestamps) - Math.min(...timestamps);

  const denominator =
    metrics.usageInput + metrics.usageCacheRead + metrics.usageCacheWrite;
  return {
    sessionId: createHash('sha256').update(source).digest('hex').slice(0, 12),
    ...metrics,
    autonomyMode,
    cacheHitRatio: denominator === 0 ? 0 : metrics.usageCacheRead / denominator,
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
  const denominator =
    totals.usageInput + totals.usageCacheRead + totals.usageCacheWrite;
  totals.cacheHitRatio =
    denominator === 0 ? 0 : totals.usageCacheRead / denominator;
  const medians = Object.fromEntries(
    [...METRIC_KEYS, 'cacheHitRatio', 'malformedLines'].map((key) => [
      key,
      median(sessions.map((session) => session[key])),
    ]),
  );
  const modeCounts = Object.fromEntries(
    [...new Set(sessions.map((session) => session.autonomyMode))].map(
      (mode) => [
        mode,
        sessions.filter((session) => session.autonomyMode === mode).length,
      ],
    ),
  );
  return { sessionCount: sessions.length, totals, medians, modeCounts };
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
    if (session.todoToolCalls >= (options.minTodoCalls ?? 0))
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
  return 'Usage: session-metrics summarize <file|dir>... [--limit N] [--min-todo-calls N]\n       session-metrics compare --baseline <file|dir> [--baseline ...] --comparison <file|dir> [--comparison ...] [--limit N] [--min-todo-calls N]';
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
  const plain = [];
  const baseline = [];
  const comparison = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--limit') limit = positiveInteger(rest[++index], arg);
    else if (arg === '--min-todo-calls')
      minTodoCalls = positiveInteger(rest[++index], arg, true);
    else if (arg === '--baseline') baseline.push(rest[++index]);
    else if (arg === '--comparison') comparison.push(rest[++index]);
    else if (arg?.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else plain.push(arg);
  }
  const options = { limit, minTodoCalls };
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
