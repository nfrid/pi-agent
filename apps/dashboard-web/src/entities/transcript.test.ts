import { projectActivityGroups } from '@pi-dashboard/activity-model';
import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { ActivityGroupsViewModelSchema } from '../../../../extensions/activity-groups/contribution';
import { toolOutcome, toTranscriptEntries } from '../transcript';
import {
  activityGroupPresentation,
  buildTranscriptGroupCoverage,
  buildVirtualTranscriptRows,
  preserveVirtualScrollOffset,
  restoreVirtualBottom,
  type TranscriptGroup,
} from './transcript';

describe('activity row views and virtual transcript construction', () => {
  it('keeps failed shared status distinct in the dashboard row view', () => {
    const group = {
      status: 'failed' as const,
      toolCount: 1,
    } as TranscriptGroup;
    const view = activityGroupPresentation(group, false);
    expect(view.status).toBe(group.status);
    expect(view.className).toBe('activity-failed');
    expect(view.icon).toBe('!');
    expect(view.label).toContain('failed');
  });

  it('projects uncompleted assistant tool calls as pending activity', () => {
    const [item] = toTranscriptEntries([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'read' }],
        },
      },
    ]).filter(({ entry }) => entry.kind === 'tool');
    expect(item?.entry).toMatchObject({ kind: 'tool', status: 'pending' });
  });

  it('normalizes historical Pi toolResult messages out of order', () => {
    const successful = toTranscriptEntries([
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'history-success',
          toolName: 'read',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        },
      },
      // Pi can replay a result while restoring a historical session.
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'history-success',
          toolName: 'read',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        },
      },
      {
        type: 'message',
        id: 'assistant-success',
        message: {
          id: 'assistant-success-message',
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'history-success',
              name: 'read',
              arguments: { path: 'file.txt' },
            },
          ],
        },
      },
    ]);
    const failed = toTranscriptEntries([
      {
        role: 'toolResult',
        toolCallId: 'history-failed',
        toolName: 'bash',
        content: [{ type: 'text', text: 'nope' }],
        isError: true,
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'history-failed',
            name: 'bash',
            arguments: { command: 'false' },
          },
        ],
      },
    ]);
    const successTool = successful.find(({ entry }) => entry.kind === 'tool');
    const failedTool = failed.find(({ entry }) => entry.kind === 'tool');
    expect(successTool).toMatchObject({
      key: 'assistant-success-message:tool:history-success',
      entry: { kind: 'tool', status: 'success' },
    });
    expect(failedTool).toMatchObject({
      entry: { kind: 'tool', status: 'error', isError: true },
    });
    expect(successful).toHaveLength(2);
    expect(failed).toHaveLength(2);
    expect(
      projectActivityGroups(successful.map(({ entry }) => entry)).map(
        ({ status }) => status,
      ),
    ).toEqual(['complete']);
    expect(
      projectActivityGroups(failed.map(({ entry }) => entry)).map(
        ({ status }) => status,
      ),
    ).toEqual(['failed']);
    expect(toolOutcome({ kind: 'tool', status: 'finished' })).toBe('success');
  });

  it('accepts complete activity projections for every tool outcome', () => {
    for (const tool of [
      { name: 'read', args: {}, status: 'success' as const },
      { name: 'bash', args: {}, status: 'error' as const, isError: true },
      { name: 'bash', args: {}, status: 'running' as const },
    ]) {
      const [group] = projectActivityGroups([
        { kind: 'assistant', speaks: false },
        { kind: 'tool', ...tool },
      ]);
      expect(Value.Check(ActivityGroupsViewModelSchema, group)).toBe(true);
    }
  });

  it('precomputes regular transcript coverage without scanning groups per item', () => {
    const groups = [
      { start: 1, end: 3 },
      { start: 6, end: 7 },
    ] as TranscriptGroup[];
    const { groupByStart, groupCoverage } = buildTranscriptGroupCoverage(
      9,
      groups,
    );
    expect([...groupByStart.keys()]).toEqual([1, 6]);
    expect([...groupCoverage]).toEqual([0, 1, 1, 1, 0, 0, 1, 1, 0]);
  });

  it('uses the same live presentation for regular and virtual group rows', () => {
    const group = {
      start: 0,
      end: 1,
      status: 'live' as const,
      toolCount: 1,
      title: 'Working',
    } as TranscriptGroup;
    const regular = activityGroupPresentation(group, false);
    const [virtual] = buildVirtualTranscriptRows(
      [{ key: 'assistant-1' }, { key: 'tool-1' }],
      [group],
    );
    expect(virtual?.kind).toBe('group');
    expect(
      virtual?.kind === 'group'
        ? activityGroupPresentation(virtual.group, false)
        : undefined,
    ).toEqual(regular);
  });

  it('constructs alternating group rows with a linear group-read invariant', () => {
    const groupCount = 20_000;
    const items = Array.from({ length: groupCount * 2 }, (_, index) => ({
      key: `entry-${index}`,
    }));
    const groups = Array.from(
      { length: groupCount },
      (_, index) =>
        ({
          start: index * 2,
          end: index * 2,
          status: 'complete',
          toolCount: 1,
          title: 'work',
        }) as TranscriptGroup,
    );
    const stats = { groupReads: 0 };
    const rows = buildVirtualTranscriptRows(items, groups, stats);
    expect(rows).toHaveLength(groupCount * 2);
    expect(rows.filter((row) => row.kind === 'group')).toHaveLength(groupCount);
    expect(rows.filter((row) => row.kind === 'entry')).toHaveLength(groupCount);
    expect(stats.groupReads).toBeLessThan(items.length * 3);
  });
});

describe('virtual transcript scroll preservation', () => {
  it('keeps the first visible row anchored while variable rows resize', () => {
    expect(preserveVirtualScrollOffset(240, 312, false)).toBe(-72);
  });

  it('does not fight bottom-stick scrolling after measurement', () => {
    expect(preserveVirtualScrollOffset(240, 312, true)).toBe(0);
  });

  it('restores the bottom after an expanded group is measured', () => {
    expect(restoreVirtualBottom(2400, 720, true)).toBe(1680);
    expect(restoreVirtualBottom(2400, 720, false)).toBeUndefined();
  });
});
