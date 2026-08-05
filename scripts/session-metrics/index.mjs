#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { aggregateEpisodeCohorts, deriveEpisodes } from './episodes.mjs';

export const SCHEMA_VERSION = 'session-metrics/v8';
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
  'delegateBackgroundAutomaticDeliveries',
  'delegateBackgroundPeekDeliveries',
  'delegateBackgroundDeliveryOverlaps',
  'unknownToolArgumentBlocks',
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
  'delegateCleanReadOnlySnapshotRetirements',
  'delegateSameSnapshotContinuations',
  'delegateWipRefreshAttempts',
  'delegateWipRefreshSuccesses',
  'delegateWipRefreshFailures',
  'delegateHeadRefreshAttempts',
  'delegateHeadRefreshSuccesses',
  'delegateHeadRefreshFailures',
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
  /^#?\s*Background delegate job (\S+) .*?\n\n((?:Delegated results:\s*\d+\s+runs?|Delegated tasks?\b)[\s\S]*)$/;

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

/** The current producers use `jobs` for automatic delivery and `job` for peek. */
function deliveredJobs(details) {
  if (Array.isArray(details?.jobs))
    return details.jobs.filter(
      (job) =>
        job &&
        typeof job === 'object' &&
        !Array.isArray(job) &&
        typeof job.id === 'string',
    );
  if (
    details?.job &&
    typeof details.job === 'object' &&
    typeof details.job.id === 'string'
  )
    return [details.job];
  return [];
}

function isSettledJob(job) {
  // A terminal state alone is not a parent-visible delivery: cancel can return
  // snapshots for jobs that were still running (or were merely cancelled).
  // Only a handoff or error is evidence that this job produced delivered work.
  return (
    (typeof job?.handoff === 'string' && job.handoff.length > 0) ||
    (typeof job?.error === 'string' && job.error.length > 0)
  );
}

/** A terminal tool result can retain a snapshot while its automatic steer waits. */
function automaticQueuedJobIds(details) {
  if (details?.delivery !== 'automatic-queued') return new Set();
  if (Array.isArray(details.automaticQueuedJobIds))
    return new Set(
      details.automaticQueuedJobIds.filter((id) => typeof id === 'string'),
    );
  return new Set(deliveredJobs(details).map((job) => job.id));
}

/**
 * Handoff copies cost context every time they enter the parent transcript, but
 * job/run facts are keyed by their stable job identity. Do not parse the text
 * into jobs: parallel handoffs themselves may contain the display separator.
 */
function recordDeliverySource(state, source, ids) {
  if (source === 'automatic') {
    state.metrics.delegateBackgroundAutomaticDeliveries += ids.length;
    for (const id of ids) {
      state.automaticDeliveryIds.add(id);
      if (state.peekDeliveryIds.has(id) && !state.overlapDeliveryIds.has(id)) {
        state.overlapDeliveryIds.add(id);
        state.metrics.delegateBackgroundDeliveryOverlaps += 1;
      }
    }
  } else if (source === 'peek') {
    state.metrics.delegateBackgroundPeekDeliveries += ids.length;
    for (const id of ids) {
      state.peekDeliveryIds.add(id);
      if (
        state.automaticDeliveryIds.has(id) &&
        !state.overlapDeliveryIds.has(id)
      ) {
        state.overlapDeliveryIds.add(id);
        state.metrics.delegateBackgroundDeliveryOverlaps += 1;
      }
    }
  }
}

function recordBackgroundDelivery(state, text, details, source) {
  const suppressed = automaticQueuedJobIds(details);
  const jobs = deliveredJobs(details).filter(
    (job) => isSettledJob(job) && !suppressed.has(job.id),
  );
  if (jobs.length === 0) {
    // Older transcripts have no details. One header is enough to identify one
    // report, but cannot honestly reconstruct a parallel fan from its text.
    const legacy = text.match(BACKGROUND_DELIVERY_MARKER);
    if (!legacy) return;
    const [, jobId, handoff] = legacy;
    recordDeliveredText(state, text, 1);
    recordDeliverySource(state, source, [jobId]);
    const ids = [`${jobId}:0`];
    recordTruncatedTasks(state, ids, handoff);
    recordExecution(state, [{}], ids, handoff);
    return;
  }

  recordDeliveredText(state, text, jobs.length);
  recordDeliverySource(
    state,
    source,
    jobs.map((job) => job.id),
  );
  for (const job of jobs) {
    const runs = Array.isArray(job.runs) && job.runs.length ? job.runs : [job];
    const ids = runs.map((_, index) => `${job.id}:${index}`);
    // Snapshot handoff is authoritative for per-run report facts. The full
    // delivered text is deliberately used only for parent-context bytes.
    const handoff = typeof job.handoff === 'string' ? job.handoff : '';
    recordTruncatedTasks(state, ids, handoff);
    recordExecution(state, runs, ids, handoff);
    const entries = state.backgroundLifecycleEntries.get(job.id) ?? [];
    for (let index = 0; index < runs.length; index += 1)
      recordLifecycleRun(state, ids[index], entries[index], runs[index]);
    recordRouting(state, runs, ids);
  }
}

function recordDeliveredText(state, text, deliveries) {
  state.metrics.delegateBackgroundDeliveries += deliveries;
  state.metrics.delegateHandoffBytes += Buffer.byteLength(text, 'utf8');
  state.metrics.delegateArtifactFallbacks += countOccurrences(
    text,
    'Exact output artifact unavailable',
  );
}

/** Emitted once per run envelope by the current delegate build. */
const TRUNCATED_MARKER = 'Truncation: original report truncated';
/** Markers emitted by earlier report contracts, retained for old transcripts. */
const LEGACY_TRUNCATED_MARKERS = [
  'Truncation: body truncated',
  '[Output truncated for parent context',
];

function countOccurrences(text, marker) {
  return text.split(marker).length - 1;
}

/** A repeated pushed/peeked handoff must not inflate a unique-task rate. */
function recordTruncatedTasks(state, ids, text) {
  const truncated = Math.max(
    countOccurrences(text, TRUNCATED_MARKER),
    ...LEGACY_TRUNCATED_MARKERS.map((marker) => countOccurrences(text, marker)),
  );
  for (const id of ids.slice(0, truncated)) {
    if (state.truncatedRuns.has(id)) continue;
    state.truncatedRuns.add(id);
    state.metrics.delegateTruncatedTasks += 1;
  }
}

function resultText(message) {
  if (typeof message.content === 'string') return message.content;
  return (Array.isArray(message.content) ? message.content : [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

const UNKNOWN_TOOL_ARGUMENT_BLOCK =
  /^Tool "[^"\r\n]+" does not support argument "[^"\r\n]+"\. Remove it and retry\.$/;

function isUnknownToolArgumentBlock(message) {
  return (
    message?.isError === true &&
    UNKNOWN_TOOL_ARGUMENT_BLOCK.test(resultText(message))
  );
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

function recordDelegateResult(state, message, executionNumber, entries = []) {
  const { metrics } = state;
  const runs = Array.isArray(message.details?.runs) ? message.details.runs : [];
  const stableCallId =
    typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
  if (runs.length === 0) {
    metrics.delegateRejectedCalls += 1;
    if (stableCallId)
      for (let index = 0; index < entries.length; index += 1)
        recordLifecycleRun(
          state,
          `${stableCallId}:${index}`,
          entries[index],
          undefined,
          true,
        );
    return { runs, background: false };
  }
  const text = resultText(message);
  const background = BACKGROUND_START_MARKER.test(text);
  if (message.details?.mode === 'parallel') metrics.delegateParallelCalls += 1;
  if (background) {
    const jobIds = backgroundJobIds(text);
    metrics.delegateBackgroundJobsLaunched += jobIds.length || runs.length;
    metrics.delegateBackgroundRunsLaunched += runs.length;
    const ids = runs.map(
      (run, index) =>
        `${run?.backgroundJobId ?? jobIds[index] ?? `launch:${executionNumber}:${index}`}:0`,
    );
    recordExecution(state, runs, ids, '', false);
    for (let index = 0; index < runs.length; index += 1) {
      const jobId = runs[index]?.backgroundJobId ?? jobIds[index];
      if (jobId && stableCallId)
        state.backgroundLifecycleEntries.set(jobId, [entries[index] ?? {}]);
    }
    return { runs, background: true };
  }
  const ids = runs.map((_, index) =>
    stableCallId
      ? `${stableCallId}:${index}`
      : `foreground:${executionNumber}:${index}`,
  );
  recordExecution(state, runs, ids, text);
  if (stableCallId)
    for (let index = 0; index < runs.length; index += 1)
      recordLifecycleRun(state, ids[index], entries[index], runs[index]);
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

function lifecycleEntries(call) {
  const args = toolArguments(call);
  const tasks =
    Array.isArray(args.tasks) && args.tasks.length ? args.tasks : [args];
  return tasks.map((task) => ({
    continuation: typeof task?.continuation === 'string',
    refresh:
      task?.refresh === 'wip' || task?.refresh === 'head'
        ? task.refresh
        : undefined,
  }));
}

function hasLifecycleMetadata(worktree) {
  return (
    worktree &&
    (worktree.snapshotBase === 'wip' || worktree.snapshotBase === 'head')
  );
}

function successfulRun(run) {
  return (
    run?.state === 'success' ||
    (run?.exitCode === 0 &&
      run?.stopReason !== 'error' &&
      run?.stopReason !== 'aborted')
  );
}

/** Record bounded lifecycle facts once per stable run identity. */
function recordLifecycleRun(state, id, entry, run, failedResult = false) {
  if (!entry || state.lifecycleRuns.has(id)) return;
  const successful = !failedResult && successfulRun(run);
  const worktree = run?.worktree;
  const metadata = hasLifecycleMetadata(worktree);
  const cleanReadOnlySnapshot =
    successful &&
    metadata &&
    run?.allowWrites === false &&
    worktree.snapshot === true &&
    worktree.status === 'finished' &&
    worktree.hasWork === false &&
    !worktree.error &&
    !worktree.runOutcome;
  state.lifecycleRuns.add(id);
  if (cleanReadOnlySnapshot)
    state.metrics.delegateCleanReadOnlySnapshotRetirements += 1;

  if (entry.refresh) {
    const prefix =
      entry.refresh === 'wip' ? 'delegateWipRefresh' : 'delegateHeadRefresh';
    if (
      !successful &&
      !failedResult &&
      run?.state === undefined &&
      run?.exitCode === undefined
    )
      return;
    state.metrics[`${prefix}Attempts`] += 1;
    state.metrics[`${prefix}${successful ? 'Successes' : 'Failures'}`] += 1;

    return;
  }

  if (
    entry.continuation &&
    successful &&
    metadata &&
    worktree.snapshot === true &&
    worktree.status === 'finished' &&
    worktree.hasWork === false &&
    !worktree.error &&
    !worktree.runOutcome
  )
    state.metrics.delegateSameSnapshotContinuations += 1;
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

export function parseSessionJsonl(source, options = {}) {
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
    automaticDeliveryIds: new Set(),
    peekDeliveryIds: new Set(),
    overlapDeliveryIds: new Set(),
    lifecycleRuns: new Set(),
    delegateLifecycleEntries: new Map(),
    backgroundLifecycleEntries: new Map(),
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
        entry.details,
        'automatic',
      );
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message?.role === 'user') metrics.userTurns += 1;
    if (message?.role === 'assistant') {
      metrics.assistantTurns += 1;
      metrics.todoToolCalls += toolCalls(message, 'todo').length;
      const delegated = toolCalls(message, 'delegate');
      metrics.delegateToolCalls += delegated.length;
      for (const call of delegated)
        if (typeof call.id === 'string')
          state.delegateLifecycleEntries.set(call.id, lifecycleEntries(call));
      metrics.delegateContinuationCalls += delegated.filter(
        (call) => continuationEntries(call).length > 0,
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
    if (message?.role === 'toolResult' && isUnknownToolArgumentBlock(message))
      metrics.unknownToolArgumentBlocks += 1;
    if (message?.role === 'toolResult' && message.toolName === 'delegate') {
      const result = recordDelegateResult(
        state,
        message,
        delegateResultNumber++,
        typeof message.toolCallId === 'string'
          ? (state.delegateLifecycleEntries.get(message.toolCallId) ?? [])
          : [],
      );
      if (!result.background)
        recordRouting(
          state,
          result.runs,
          result.runs.map((_, index) =>
            typeof message.toolCallId === 'string'
              ? `${message.toolCallId}:${index}`
              : `foreground:${delegateResultNumber - 1}:${index}`,
          ),
        );
    }
    if (
      message?.role === 'toolResult' &&
      message.toolName === 'delegate_jobs' &&
      ['peek', 'cancel'].includes(message.details?.action)
    )
      recordBackgroundDelivery(
        state,
        resultText(message),
        message.details,
        message.details.action === 'peek' ? 'peek' : undefined,
      );
  }
  if (timestamps.length > 1)
    metrics.elapsedMs = Math.max(...timestamps) - Math.min(...timestamps);

  const episodeRecords = deriveEpisodes(active);
  const result = {
    sessionId: createHash('sha256').update(source).digest('hex').slice(0, 12),
    ...withRatios(metrics),
    routes: state.routes,
    malformedLines,
    episodeCohorts: aggregateEpisodeCohorts(episodeRecords),
  };
  // Keep full records available to aggregateSessions without making them part
  // of the default JSON output. `--episodes` is the explicit opt-in surface.
  Object.defineProperty(result, '__episodeRecords', {
    value: episodeRecords,
    enumerable: false,
  });
  if (options.includeEpisodes === true) result.episodes = episodeRecords;
  return result;
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
    episodeCohorts: aggregateEpisodeCohorts(
      sessions.flatMap((session) => session.__episodeRecords ?? []),
    ),
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
    const session = parseSessionJsonl(await readFile(file, 'utf8'), {
      includeEpisodes: options.includeEpisodes === true,
    });
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
  return 'Usage: session-metrics summarize <file|dir>... [--limit N] [--min-todo-calls N] [--min-delegate-calls N] [--episodes]\n       session-metrics compare --baseline <file|dir> [--baseline ...] --comparison <file|dir> [--comparison ...] [--limit N] [--min-todo-calls N] [--min-delegate-calls N] [--episodes]';
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
  let includeEpisodes = false;
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
    else if (arg === '--episodes' || arg === '--include-episodes')
      includeEpisodes = true;
    else if (arg === '--baseline') baseline.push(rest[++index]);
    else if (arg === '--comparison') comparison.push(rest[++index]);
    else if (arg?.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else plain.push(arg);
  }
  const options = { limit, minTodoCalls, minDelegateCalls, includeEpisodes };
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
