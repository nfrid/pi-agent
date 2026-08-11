import { describe, expect, it } from 'vitest';
import { latestDelegateDetails, transcriptText } from './transcript';
import { createRun } from './types';

describe('delegate transcript viewer data', () => {
  it('selects the latest matching delegate result from the active branch', () => {
    const first = createRun('old task', undefined, { name: 'Old' });
    const latest = createRun('inspect cache', undefined, { name: 'Cache review' });
    const branch = [
      { type: 'message', message: { role: 'toolResult', toolName: 'delegate', details: { mode: 'single', runs: [first] } } },
      { type: 'message', message: { role: 'toolResult', toolName: 'delegate', details: { mode: 'single', runs: [latest] } } },
    ];

    expect(latestDelegateDetails(branch, 'cache')?.runs[0]?.name).toBe('Cache review');
    expect(latestDelegateDetails(branch)?.runs[0]?.task).toBe('inspect cache');
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
