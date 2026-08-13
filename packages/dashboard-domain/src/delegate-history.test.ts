import {
  parseDelegateHistoryResponse,
  parseDelegateHistoryRunDetailResponse,
} from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  delegateHistoryFromBranch,
  delegateHistoryRunDetailFromBranch,
} from './delegate-history.js';

function oldRun(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Review',
    task: 'inspect the change',
    exitCode: 0,
    state: 'success',
    activities: [],
    ...overrides,
  };
}

describe('delegate history adapter', () => {
  it('extracts foreground and background summary metadata from the selected branch', () => {
    const response = delegateHistoryFromBranch(
      'parent-1',
      [
        { type: 'session', id: 'parent-1' },
        {
          type: 'message',
          id: 'foreground-result',
          message: {
            role: 'toolResult',
            toolName: 'delegate',
            details: {
              mode: 'single',
              runs: [oldRun({ continuation: 'legacy-token' })],
            },
          },
        },
        {
          type: 'message',
          id: 'background-result',
          message: {
            customType: 'delegate-job-result',
            details: {
              jobs: [
                {
                  id: 'job-1',
                  name: 'Background review',
                  state: 'success',
                  runs: [oldRun({ continuation: 'legacy-token' })],
                },
              ],
            },
          },
        },
      ],
      'background-result',
    );

    expect(response.leafId).toBe('background-result');
    expect(response.groups).toHaveLength(1);
    expect(response.groups[0]).toMatchObject({
      name: 'Review',
      lineageId: 'dl-dea8c20f3c21ef45',
      runCount: 2,
    });
    expect(response.groups[0]?.runs[0]?.runId).not.toBe(
      response.groups[0]?.runs[1]?.runId,
    );
    expect(response.groups[0]?.runs[1]).toMatchObject({
      kind: 'background',
      jobId: 'job-1',
      task: 'inspect the change',
    });
    expect(response.groups[0]?.runs[1]).not.toHaveProperty('details');
    expect(parseDelegateHistoryResponse(response)).toEqual(response);
    const detail = delegateHistoryRunDetailFromBranch(
      'parent-1',
      [
        { type: 'session', id: 'parent-1' },
        {
          type: 'message',
          id: 'background-result',
          message: {
            customType: 'delegate-job-result',
            details: {
              jobs: [
                {
                  id: 'job-1',
                  name: 'Background review',
                  state: 'success',
                  runs: [oldRun({ continuation: 'legacy-token' })],
                },
              ],
            },
          },
        },
      ],
      response.groups[0]?.runs[1]?.runId ?? '',
      response.groups[0]?.runs[1]?.lineageId,
      'background-result',
    );
    expect(
      parseDelegateHistoryRunDetailResponse(detail).run.details,
    ).toMatchObject({
      task: 'inspect the change',
      truncated: false,
    });
  });

  it('bounds runs per lineage and marks omitted records', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      ...Array.from({ length: 130 }, (_, index) => ({
        type: 'message',
        id: `result-${index}`,
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            mode: 'single',
            runs: [oldRun({ continuation: 'legacy-token' })],
          },
        },
      })),
    ];
    const response = delegateHistoryFromBranch('parent-1', branch);
    expect(response.truncated).toBe(true);
    expect(response.groups).toHaveLength(1);
    expect(response.groups[0]).toMatchObject({
      runCount: 128,
      truncated: true,
    });
    expect(parseDelegateHistoryResponse(response)).toEqual(response);
  });

  it('trims oldest oversized continuations while retaining the newest run', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      ...Array.from({ length: 8 }, (_, index) => ({
        type: 'message',
        id: `result-${index}`,
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            mode: 'single',
            runs: [
              oldRun({
                name: `Continuation ${index}`,
                task: 'x'.repeat(20_000),
                continuation: `continuation-${index}`,
                state: 'success',
                startedAt: index + 10,
                finishedAt: index + 11,
                routing: { route: `route-${index}` },
                backgroundJobId: `job-${index}`,
              }),
            ],
          },
        },
      })),
      {
        type: 'message',
        id: 'result-8',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            mode: 'single',
            runs: [
              oldRun({
                name: 'Continuation 7 current',
                task: 'x'.repeat(20_000),
                continuation: 'continuation-7',
                state: 'error',
                startedAt: 18,
                finishedAt: 19,
                routing: { route: 'route-current' },
                backgroundJobId: 'job-current',
              }),
            ],
          },
        },
      },
    ];

    const response = delegateHistoryFromBranch('parent-1', branch);
    const newest = response.groups.at(-1);
    expect(response.truncated).toBe(true);
    expect(newest).toMatchObject({
      name: 'Continuation 7 current',
      runId: newest?.runs.at(-1)?.runId,
      state: 'error',
      createdAt: 17,
      startedAt: 18,
      finishedAt: 19,
      jobId: 'job-current',
      route: 'route-current',
      runCount: 2,
    });
    expect(newest?.runs).toHaveLength(2);
    expect(newest?.runs[0]?.task).toBe('x'.repeat(20_000));
    expect(parseDelegateHistoryResponse(response)).toEqual(response);
  });

  it('bounds selected detail payloads and marks omitted fields', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      {
        type: 'message',
        id: 'result-large',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            mode: 'single',
            runs: [
              oldRun({
                task: 'task '.repeat(20_000),
                structuredResult: {
                  valid: true,
                  value: 'value '.repeat(20_000),
                  errors: [],
                },
              }),
            ],
          },
        },
      },
    ];
    const response = delegateHistoryFromBranch('parent-1', branch);
    const detail = delegateHistoryRunDetailFromBranch(
      'parent-1',
      branch,
      response.groups[0]?.runs[0]?.runId ?? '',
      response.groups[0]?.runs[0]?.lineageId,
    );
    const details = detail.run.details;
    expect(details.truncated).toBe(true);
    expect(details.task?.length).toBeLessThanOrEqual(20_000);
    expect(parseDelegateHistoryResponse(response)).toEqual(response);
  });

  it('projects selected public response and errors without stderr', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      {
        type: 'message',
        id: 'result-public-details',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            mode: 'single',
            runs: [
              oldRun({
                messages: [
                  {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Answer one.' }],
                  },
                  {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Answer two.' }],
                  },
                ],
                errorMessage: 'The runner failed safely.',
                stderr: 'private stderr must not cross the boundary',
              }),
            ],
          },
        },
      },
    ];
    const response = delegateHistoryFromBranch('parent-1', branch);
    const detail = delegateHistoryRunDetailFromBranch(
      'parent-1',
      branch,
      response.groups[0]?.runs[0]?.runId ?? '',
      response.groups[0]?.runs[0]?.lineageId,
    );
    expect(detail.run.details).toMatchObject({
      response: 'Answer one.\nAnswer two.',
      error: 'The runner failed safely.',
    });
    expect(JSON.stringify(detail)).not.toContain('private stderr');
  });

  it('keeps selected structured runs with absent messages valid', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      {
        type: 'message',
        id: 'result-empty-messages',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            mode: 'single',
            runs: [
              oldRun({
                state: undefined,
                messages: [],
                structuredResult: { valid: true, errors: [] },
              }),
            ],
          },
        },
      },
    ];
    const response = delegateHistoryFromBranch('parent-1', branch);
    const detail = delegateHistoryRunDetailFromBranch(
      'parent-1',
      branch,
      response.groups[0]?.runs[0]?.runId ?? '',
      response.groups[0]?.runs[0]?.lineageId,
    );
    expect(response.groups[0]?.runs[0]).toMatchObject({ state: 'success' });
    expect(detail.run).toMatchObject({
      state: 'success',
      details: {
        structuredResult: { valid: true, errors: [] },
        truncated: false,
      },
    });
    expect(detail.run.details).not.toHaveProperty('response');
  });

  it('keeps new identities and gives old standalone runs distinct stable IDs', () => {
    const branch = [
      { type: 'session', id: 'parent-1' },
      {
        type: 'message',
        id: 'result-a',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            mode: 'single',
            runs: [
              oldRun(),
              { ...oldRun(), runId: 'new-run', lineageId: 'new-lineage' },
            ],
          },
        },
      },
      {
        type: 'message',
        id: 'result-b',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: { mode: 'single', runs: [oldRun()] },
        },
      },
    ];
    const first = delegateHistoryFromBranch('parent-1', branch);
    const second = delegateHistoryFromBranch('parent-1', branch);
    const allRuns = first.groups.flatMap((group) => group.runs);
    const repeatRuns = second.groups.flatMap((group) => group.runs);

    expect(allRuns[1]).toMatchObject({
      runId: 'new-run',
      lineageId: 'new-lineage',
    });
    expect(allRuns[0]?.runId).toBe(repeatRuns[0]?.runId);
    expect(allRuns[0]?.runId).not.toBe(allRuns[2]?.runId);
    expect(allRuns[0]?.lineageId).toBe(allRuns[0]?.runId);
  });
});
