import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  materializeScenario,
  SCENARIOS,
  validateScenario,
} from './scenarios.mjs';

export const COMMAND_SCHEMA_VERSION = 'workflow-command/v1';
const EVENT_TYPES = new Set([
  'tool-call',
  'tool-result',
  'decision',
  'usage',
  'summary',
  'evidence',
  'complete',
]);

export async function loadCommandSpec(file) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const keys = Object.keys(raw);
  if (
    raw.schemaVersion !== COMMAND_SCHEMA_VERSION ||
    typeof raw.label !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.label) ||
    typeof raw.module !== 'string' ||
    !Array.isArray(raw.args) ||
    !raw.args.every((item) => typeof item === 'string') ||
    keys.some(
      (key) => !['schemaVersion', 'label', 'module', 'args'].includes(key),
    )
  )
    throw new Error(`Invalid ${COMMAND_SCHEMA_VERSION} spec: ${file}`);
  const modulePath = path.resolve(path.dirname(file), raw.module);
  return { ...raw, modulePath };
}

export function validateEvents(lines) {
  let priorSequence = 0;
  let priorTime = -1;
  const events = lines.map((line, index) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`Malformed replay JSONL at line ${index + 1}`);
    }
    if (
      !event ||
      !Number.isInteger(event.seq) ||
      event.seq <= priorSequence ||
      !Number.isFinite(event.atMs) ||
      event.atMs < priorTime ||
      !EVENT_TYPES.has(event.type)
    )
      throw new Error(`Invalid replay event at line ${index + 1}`);
    const allowedByType = {
      'tool-call': ['tool', 'key'],
      'tool-result': ['tool', 'key', 'ok'],
      decision: ['value'],
      usage: [
        'input',
        'cacheRead',
        'cacheWrite',
        'output',
        'context',
        'costUsd',
      ],
      summary: ['value'],
      evidence: ['value'],
      complete: [],
    };
    const allowed = new Set([
      'seq',
      'atMs',
      'type',
      ...allowedByType[event.type],
    ]);
    const unknown = Object.keys(event).filter((key) => !allowed.has(key));
    if (unknown.length > 0)
      throw new Error(
        `Replay event line ${index + 1} contains unknown fields: ${unknown.join(', ')}`,
      );
    const stringValue = (value) =>
      typeof value === 'string' && value.length > 0;
    const numericValue = (value) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const valid =
      event.type === 'tool-call'
        ? stringValue(event.tool) && stringValue(event.key)
        : event.type === 'tool-result'
          ? stringValue(event.tool) &&
            stringValue(event.key) &&
            typeof event.ok === 'boolean'
          : event.type === 'decision'
            ? event.value === 'ask' || event.value === 'proceed'
            : event.type === 'usage'
              ? allowedByType.usage.every((field) => numericValue(event[field]))
              : event.type === 'summary' || event.type === 'evidence'
                ? stringValue(event.value)
                : event.type === 'complete';
    if (!valid)
      throw new Error(`Replay event line ${index + 1} has invalid fields`);
    priorSequence = event.seq;
    priorTime = event.atMs;
    return event;
  });
  const completions = events
    .map((event, index) => (event.type === 'complete' ? index : -1))
    .filter((index) => index >= 0);
  if (completions.length !== 1 || completions[0] !== events.length - 1)
    throw new Error(
      'Replay trace requires exactly one terminal complete event',
    );
  return events;
}

export async function runCommand(spec, options) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(process.execPath, [spec.modulePath, ...spec.args], {
      cwd: options.cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? tmpdir(),
        LANG: 'C',
        LC_ALL: 'C',
        WORKFLOW_REPLAY: '1',
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached,
    });
    let stdout = '';
    let stderr = '';
    let killTimer;
    let timedOut = false;
    const killTree = (signal) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Process already exited.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), 2_000);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut)
        return reject(
          new Error(`Replay command timed out after ${timeoutMs}ms`),
        );
      if (code !== 0 || signal)
        return reject(
          new Error(
            `Replay command failed (${signal ?? code}): ${stderr.trim()}`,
          ),
        );
      try {
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        if (lines.length === 0)
          throw new Error('Replay command emitted no events');
        resolve(validateEvents(lines));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(
      `${JSON.stringify({
        schemaVersion: 'workflow-replay/v1',
        scenarioId: options.scenarioId,
        phase: options.phase ?? 'run',
        ...(options.summary ? { summary: options.summary } : {}),
      })}\n`,
    );
  });
}

function mergeEventGroups(groups) {
  let sequence = 0;
  let time = 0;
  return groups.flatMap((group) => {
    const base = time;
    const merged = group.map((event) => ({
      ...event,
      seq: ++sequence,
      atMs: base + event.atMs,
    }));
    time = merged.at(-1)?.atMs ?? time;
    return merged;
  });
}

export function traceToMetrics(scenarioId, events, validation) {
  const calls = events.filter((event) => event.type === 'tool-call');
  const keys = calls.map((event) => `${event.tool}:${event.key}`);
  const repeatReads = keys.filter(
    (key, index) => key.startsWith('read:') && keys.indexOf(key) !== index,
  ).length;
  const repeatStatuses = keys.filter(
    (key, index) => key.startsWith('status:') && keys.indexOf(key) !== index,
  ).length;
  const usage = events.filter((event) => event.type === 'usage');
  const total = (field) =>
    usage.reduce((sum, event) => sum + Number(event[field] ?? 0), 0);
  const questions = events.filter(
    (event) => event.type === 'decision' && event.value === 'ask',
  ).length;
  return {
    scenarioId,
    completed: validation.completed,
    validationPassed: validation.validationPassed,
    statePreserved: validation.statePreserved,
    userInterventions: questions,
    avoidableQuestions: scenarioId === 'ambiguous-decision' ? 0 : questions,
    toolCalls: calls.length,
    repeatReads,
    repeatStatuses,
    elapsedMs: events.at(-1)?.atMs ?? 0,
    uncachedInput: total('input') + total('cacheWrite'),
    cacheRead: total('cacheRead'),
    cacheWrite: total('cacheWrite'),
    output: total('output'),
    peakContext: Math.max(
      0,
      ...usage.map((event) => Number(event.context ?? 0)),
    ),
    delegateCostUsd: total('costUsd'),
    capabilityViolations: validation.protectedStatePreserved ? 0 : 1,
  };
}

export async function runScenario(spec, scenarioId, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), `workflow-${scenarioId}-`));
  try {
    const before = await materializeScenario(scenarioId, root);
    let groups;
    if (scenarioId === 'compaction') {
      const first = await runCommand(spec, {
        cwd: root,
        scenarioId,
        phase: 'prepare',
        timeoutMs: options.timeoutMs,
      });
      const summary = first.find((event) => event.type === 'summary')?.value;
      if (typeof summary !== 'string')
        throw new Error('Compaction replay did not produce a summary');
      const second = await runCommand(spec, {
        cwd: root,
        scenarioId,
        phase: 'resume',
        summary,
        timeoutMs: options.timeoutMs,
      });
      groups = [first, second];
    } else {
      groups = [
        await runCommand(spec, {
          cwd: root,
          scenarioId,
          timeoutMs: options.timeoutMs,
        }),
      ];
    }
    const events = mergeEventGroups(groups);
    const validation = await validateScenario(scenarioId, root, before, events);
    return traceToMetrics(scenarioId, events, validation);
  } catch (error) {
    throw new Error(
      `${scenarioId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runSuite(spec, options = {}) {
  const runs = [];
  for (const scenario of options.scenarios ?? SCENARIOS)
    runs.push(await runScenario(spec, scenario, options));
  return {
    schemaVersion: 'workflow-benchmark/v1',
    label: spec.label,
    runs,
  };
}
