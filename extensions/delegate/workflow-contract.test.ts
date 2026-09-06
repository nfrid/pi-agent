import { describe, expect, test } from 'vitest';
import { createRun } from './types';
import {
  captureWorkflowText,
  compactWorkflowResult,
  durableWorkflowResult,
  isValidDurableWorkflowResult,
  MAX_WORKFLOW_RESULT_BYTES,
  WORKFLOW_INPUT_CAPS,
  WORKFLOW_OVERSIZED_EVIDENCE_MARKER,
} from './workflow-contract';

function result(text: string) {
  const run = createRun('contract test');
  run.state = 'success';
  run.exitCode = 0;
  run.messages = [
    { role: 'assistant', content: [{ type: 'text', text }] },
  ] as never;
  return { runs: [run], handoff: text };
}

describe('workflow evidence contract', () => {
  test('uses UTF-8 byte bounds and preserves oversized evidence as a marker', () => {
    const exact = '🙂'.repeat(WORKFLOW_INPUT_CAPS.perItemMaxBytes / 4);
    const oversized = `${exact}🙂`;
    expect(captureWorkflowText(exact)).toEqual({
      text: exact,
      bytes: WORKFLOW_INPUT_CAPS.perItemMaxBytes,
    });
    expect(captureWorkflowText(oversized)).toEqual({
      text: WORKFLOW_OVERSIZED_EVIDENCE_MARKER,
      bytes: WORKFLOW_INPUT_CAPS.perItemMaxBytes + 4,
      oversized: true,
    });
  });

  test('round-trips producer output through the durable persistence boundary', () => {
    const live = compactWorkflowResult(result('🙂'.repeat(32)));
    const durable = durableWorkflowResult(live);
    const restored = JSON.parse(JSON.stringify(durable)) as unknown;
    expect(isValidDurableWorkflowResult(restored)).toBe(true);
    expect(restored).toMatchObject({
      reports: [],
      handoff: { text: '🙂'.repeat(32), bytes: 128 },
      runs: [{ state: 'success' }],
    });
  });

  test('rejects an aggregate-over-cap durable result without clipping it', () => {
    const runs = Array.from({ length: 32 }, () => {
      const run = createRun('small');
      run.state = 'success';
      run.exitCode = 0;
      run.routing = {
        route: 'test',
        provider: 'test',
        model: 'test',
        thinking: 'low',
        relativeCost: 1,
        warning: '🙂'.repeat(500),
      };
      return run;
    });
    const durable = durableWorkflowResult(
      compactWorkflowResult({ runs, handoff: 'small' }),
    );
    expect(Buffer.byteLength(JSON.stringify(durable), 'utf8')).toBeGreaterThan(
      MAX_WORKFLOW_RESULT_BYTES,
    );
    expect(isValidDurableWorkflowResult(durable)).toBe(false);
  });
});
