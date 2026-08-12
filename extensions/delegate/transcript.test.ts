import { describe, expect, it } from 'vitest';
import { processJsonLine } from './events';
import { getDetails } from './render-utils';
import {
  captureDelegateResultEvent,
  normalizeDelegateResultSpec,
  setDelegateResultSpec,
  settleDelegateResult,
} from './structured-result';
import { makeDetails } from './tool-result';
import {
  latestDelegateDetails,
  transcriptText,
  transcriptVisibleRows,
} from './transcript';
import { createRun } from './types';

describe('delegate transcript viewer data', () => {
  it('selects the latest matching delegate result from the active branch', () => {
    const first = createRun('old task', undefined, { name: 'Old' });
    const latest = createRun('inspect cache', undefined, {
      name: 'Cache review',
    });
    const branch = [
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: { mode: 'single', runs: [first] },
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: { mode: 'single', runs: [latest] },
        },
      },
    ];

    expect(latestDelegateDetails(branch, 'cache')?.runs[0]?.name).toBe(
      'Cache review',
    );
    expect(latestDelegateDetails(branch)?.runs[0]?.task).toBe('inspect cache');
  });

  it('finds completed background delegate results in custom messages', () => {
    const run = {
      ...createRun('background audit', undefined, {
        name: 'Background reviewer',
      }),
      state: 'success' as const,
      finishedAt: Date.now(),
    };
    const branch = [
      {
        type: 'message',
        message: {
          role: 'custom',
          customType: 'delegate-job-result',
          details: {
            jobs: [
              {
                id: 'job-1',
                name: 'Background reviewer',
                mode: 'single',
                runs: [run],
              },
            ],
          },
        },
      },
    ];

    expect(latestDelegateDetails(branch, 'background')?.runs[0]?.task).toBe(
      'background audit',
    );
  });

  it('budgets modal content inside the 80% overlay height', () => {
    expect(transcriptVisibleRows(24)).toBe(15);
    expect(transcriptVisibleRows(24) + 4).toBeLessThanOrEqual(
      Math.floor(24 * 0.8),
    );
  });

  it('retains bounded thinking and tool payloads through public details replay', () => {
    const run = createRun('inspect persisted execution');
    processJsonLine(
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'bounded child thinking',
        },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: 'bash-1',
        toolName: 'bash',
        args: { command: 'printf persisted' },
      }),
      run,
    );
    processJsonLine(
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'bash-1',
        toolName: 'bash',
        result: { output: 'persisted output', exitCode: 0 },
      }),
      run,
    );

    const persisted = JSON.parse(JSON.stringify(makeDetails('single', [run])));
    const replayed = getDetails({ details: persisted });
    const replayedRun = replayed?.runs[0];
    expect(replayedRun?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          transcriptText: 'bounded child thinking',
        }),
        expect.objectContaining({
          type: 'tool',
          toolArguments: { command: 'printf persisted' },
          toolResult: { output: 'persisted output', exitCode: 0 },
        }),
      ]),
    );
    expect(transcriptText(replayed?.runs ?? [])).toContain(
      'bounded child thinking',
    );
  });

  it('replays the complete validated structured value into the transcript modal', () => {
    const spec = normalizeDelegateResultSpec({
      schema: {
        type: 'object',
        properties: {
          outcome: { type: 'string' },
          details: { type: 'array', items: { type: 'string' } },
        },
        required: ['outcome', 'details'],
      },
    });
    if (!spec) throw new Error('expected normalized result spec');
    const run = createRun('structured replay');
    run.state = 'success';
    setDelegateResultSpec(run, spec);
    captureDelegateResultEvent(
      run,
      { details: { outcome: 'done', details: ['first', 'second'] } },
      false,
    );
    settleDelegateResult(run);
    const persisted = JSON.parse(JSON.stringify(makeDetails('single', [run])));
    const replayed = getDetails({ details: persisted });
    const text = transcriptText(replayed?.runs ?? []);
    expect(text).toContain('Structured result:');
    expect(text).toContain('Outcome: done');
    expect(text).toContain('2. second');
  });

  it('retains activity/response text and marks modal truncation explicitly', () => {
    const run = createRun('audit');
    run.activities.push({
      type: 'tool',
      label: 'read source.ts',
      latestText: 'source output',
      status: 'completed',
    });
    run.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    } as never);
    expect(transcriptText([run])).toContain('read source.ts');
    expect(transcriptText([run])).toContain('Response: done');

    run.task = 'x'.repeat(70_000);
    expect(transcriptText([run])).toContain('[truncated;');
  });
});
