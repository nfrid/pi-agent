import { projectActivityGroups } from '@pi-dashboard/activity-model';
import {
  hydrateTranscript,
  projectTranscriptForRender,
  reduceTranscriptEvent,
  STEERING_MESSAGE_MARKER_TYPE,
} from '@pi-dashboard/domain';
import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { ActivityGroupsViewModelSchema } from '../../../../extensions/activity-groups/contribution';
import { toolOutcome, toTranscriptEntries } from '../transcript';
import {
  activityGroupMetadata,
  activityGroupPresentation,
  activityGroupSummary,
  activityStepParts,
  buildTranscriptGroupCoverage,
  buildTranscriptLandmarks,
  buildVirtualTranscriptRows,
  displayActivityPath,
  preserveVirtualScrollOffset,
  restoreVirtualBottom,
  type TranscriptGroup,
} from './transcript';

describe('activity row views and virtual transcript construction', () => {
  it('labels steering messages in the transcript and outline without adding a row', () => {
    const items = toTranscriptEntries([
      {
        type: 'message',
        id: 'user-steer',
        message: {
          role: 'user',
          content: 'Please redirect the current work.',
          timestamp: 100,
        },
      },
      {
        type: 'custom',
        customType: STEERING_MESSAGE_MARKER_TYPE,
        data: { timestamp: 100 },
        id: 'steer-marker',
      },
      {
        type: 'message',
        id: 'user-ordinary',
        message: {
          role: 'user',
          content: 'Continue normally.',
          timestamp: 101,
        },
      },
    ]);
    const steering = items.find((item) => item.key === 'user-steer');
    const ordinary = items.find((item) => item.key === 'user-ordinary');
    expect(items).toHaveLength(2);
    expect(steering).toMatchObject({
      role: 'user',
      deliveryMode: 'steer',
      text: 'Please redirect the current work.',
    });
    expect(ordinary?.deliveryMode).toBeUndefined();
    const [landmarkSteer, landmarkOrdinary] = buildTranscriptLandmarks(items);
    expect(landmarkSteer).toMatchObject({
      kind: 'user',
      deliveryMode: 'steer',
      label: 'Steering · Please redirect the current work.',
    });
    expect(landmarkOrdinary?.label).toBe('Continue normally.');
  });

  it('keeps rich outline preview text and message timestamps', () => {
    const text =
      `Outline detail ${'with more useful context '.repeat(8)}`.trim();
    const [item] = toTranscriptEntries([
      {
        type: 'message',
        message: {
          role: 'user',
          content: text,
          timestamp: '2026-08-05T18:42:00.000Z',
        },
      },
    ]);
    expect(item).toBeDefined();
    const [landmark] = buildTranscriptLandmarks(item ? [item] : []);
    expect(landmark).toMatchObject({
      kind: 'user',
      label: text,
      timestamp: '2026-08-05T18:42:00.000Z',
    });
    expect(landmark?.label.length).toBeGreaterThan(72);
  });

  it('separates tool names from their high-signal arguments', () => {
    expect(
      activityStepParts({
        name: 'functions.bash',
        args: { command: 'pnpm run check' },
      }),
    ).toEqual({
      label: 'Running pnpm run check',
      action: 'Running',
      argument: 'pnpm run check',
      role: 'command',
      state: 'complete',
    });
    expect(
      activityStepParts({ name: 'read', args: { path: 'src/App.tsx' } }),
    ).toEqual({
      label: 'Reading src/App.tsx',
      action: 'Reading',
      argument: 'src/App.tsx',
      role: 'read',
      state: 'complete',
    });
    expect(activityStepParts({ name: 'todo', args: {} })).toEqual({
      label: 'Updating tasks',
      action: 'Updating tasks',
      role: 'other',
      state: 'complete',
    });
  });

  it('keeps workspace paths relative and outside paths absolute', () => {
    expect(
      displayActivityPath(
        '/Users/example/Code/project/src/index.ts',
        '/Users/example/Code/project',
      ),
    ).toBe('src/index.ts');
    expect(
      displayActivityPath(
        '/Users/example/shared/config.json',
        '/Users/example/Code/project',
      ),
    ).toBe('/Users/example/shared/config.json');
    expect(displayActivityPath('./src/App.tsx', '/workspace')).toBe(
      'src/App.tsx',
    );
    expect(
      displayActivityPath(
        'C:\\Users\\example\\Code\\project\\src\\index.ts',
        'c:\\users\\example\\code\\project',
      ),
    ).toBe('src/index.ts');
  });

  it('preserves supported alternate action argument names', () => {
    expect(
      activityStepParts({ name: 'bash', args: { script: 'pnpm test' } }),
    ).toMatchObject({ action: 'Running', argument: 'pnpm test' });
    expect(
      activityStepParts({
        name: 'todo',
        args: { operation: 'done', taskId: 'T4' },
      }),
    ).toMatchObject({ action: 'Tasks done', argument: 'T4' });
    expect(
      activityStepParts({ name: 'web_search', args: { q: 'Pi dashboard' } }),
    ).toMatchObject({ action: 'Searching the web', argument: 'Pi dashboard' });
    expect(
      activityStepParts({
        name: 'fetch_content',
        args: { href: 'https://example.com/docs' },
      }),
    ).toMatchObject({
      action: 'Fetching',
      argument: 'https://example.com/docs',
    });
  });

  it('summarizes delegation, artifacts, fetches, and file ranges usefully', () => {
    expect(
      activityStepParts({
        name: 'delegate_branches',
        args: {
          action: 'drop',
          id: '136d280a-7c10-4427-9d2d-1f7e62acd03b',
        },
      }),
    ).toMatchObject({
      action: 'Dropping delegate branch',
      argument: '136d280a…cd03b',
      role: 'command',
    });
    expect(
      activityStepParts({
        name: 'artifact_retrieve',
        args: { mode: 'lines', offset: 0, limit: 120 },
      }),
    ).toMatchObject({
      action: 'Reading artifact',
      argument: 'lines 1–120',
      role: 'read',
    });
    expect(
      activityStepParts({
        name: 'fetch_content',
        args: { urls: ['https://one.test', 'https://two.test'] },
      }),
    ).toMatchObject({ action: 'Fetching', argument: '2 pages', role: 'read' });
    expect(
      activityStepParts({
        name: 'get_search_content',
        args: { responseId: 'result', urlIndex: 1 },
      }),
    ).toMatchObject({
      action: 'Reading search result',
      argument: 'result 2',
      role: 'read',
    });
    expect(
      activityStepParts(
        {
          name: 'read',
          args: { path: '/workspace/src/App.tsx', offset: 20, limit: 8 },
        },
        '/workspace',
      ),
    ).toMatchObject({ action: 'Reading', argument: 'src/App.tsx:20–27' });
    expect(
      activityStepParts({
        name: 'edit',
        args: { path: 'src/App.tsx', edits: [{}, {}, {}] },
      }),
    ).toMatchObject({ action: 'Editing', argument: 'src/App.tsx · 3 changes' });
  });

  it('derives a bounded latest-step summary from the canonical group model', () => {
    const group = {
      toolCount: 5,
      tools: [
        { name: 'read', args: {} },
        { name: 'grep', args: {} },
        { name: 'edit', args: {}, status: 'error' },
        { name: 'bash', args: {}, isError: true },
        { name: 'write', args: {} },
      ],
    };
    expect(activityGroupSummary(group)).toEqual({
      recentTools: ['edit', 'bash', 'write'],
      earlierToolCount: 2,
      toolCount: 5,
      failureCount: 2,
    });
  });

  it('omits failure metadata when there are no failed calls', () => {
    expect(activityGroupMetadata({ toolCount: 2, failureCount: 0 })).toBe(
      '2 tool calls',
    );
    expect(activityGroupMetadata({ toolCount: 2, failureCount: 1 })).toBe(
      '2 tool calls · 1 failed attempt',
    );
  });

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

  it('drops empty assistant messages after filtering empty thinking', () => {
    expect(
      toTranscriptEntries([
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '   ' }],
          },
        },
      ]),
    ).toEqual([]);
  });

  it('projects semantic session events and hides extension persistence noise', () => {
    const todo = (status: string) => ({
      type: 'custom',
      customType: 'lean-todo',
      data: {
        kind: 'snapshot',
        state: {
          tasks: [{ id: 'T1', text: 'Verify dashboard', status }],
        },
      },
    });
    const items = toTranscriptEntries([
      { type: 'model_change', provider: 'openai', modelId: 'initial' },
      todo('todo'),
      todo('todo'),
      todo('doing'),
      {
        type: 'custom_message',
        customType: 'lean-todo-turn-snapshot',
        display: false,
        content: 'Todo state injected',
      },
      {
        type: 'compaction',
        summary: '## Goal\nKeep the dashboard compact.',
        tokensBefore: 232_000,
      },
      {
        type: 'message',
        message: { role: 'user', content: 'Continue.' },
      },
      { type: 'model_change', provider: 'openai', modelId: 'gpt-5.6-sol' },
      { type: 'thinking_level_change', thinkingLevel: 'medium' },
      {
        type: 'custom_message',
        customType: 'delegate-job-result',
        display: true,
        content: '# Background delegate job dj-1 (UX audit) success',
        details: { jobs: [{ name: 'UX audit', state: 'success' }] },
      },
      {
        type: 'custom',
        customType: 'artifact:v1',
        data: { bytes: 12 },
      },
      {
        type: 'custom_message',
        customType: 'extension-note',
        display: true,
        content: 'Visible extension note',
      },
    ]);
    expect(
      items.flatMap((item) => (item.event ? [item.event.kind] : [])),
    ).toEqual([
      'todo',
      'todo',
      'compaction',
      'settings',
      'delegate-result',
      'custom-message',
    ]);
    expect(
      items.find((item) => item.event?.kind === 'todo')?.event,
    ).toMatchObject({
      label: 'Tasks · T1 added · 1 waiting',
    });
    expect(
      items.find((item) => item.event?.kind === 'settings')?.event,
    ).toMatchObject({
      label: 'Model → openai/gpt-5.6-sol · thinking medium',
    });
    expect(
      items.find((item) => item.event?.kind === 'delegate-result')?.event,
    ).toMatchObject({
      label: 'Delegate finished · UX audit',
      status: 'success',
    });
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

  it('adapts the canonical domain render projection without re-pairing tools', () => {
    let projection = hydrateTranscript([], 's1');
    projection = reduceTranscriptEvent(projection, {
      type: 'message.started',
      sessionId: 's1',
      message: {
        messageId: 'assistant-live',
        role: 'assistant',
        content: [{ type: 'text', text: 'Inspecting the workspace.' }],
        toolCallIds: ['call-live'],
      },
    });
    projection = reduceTranscriptEvent(projection, {
      type: 'tool.updated',
      sessionId: 's1',
      tool: {
        toolCallId: 'call-live',
        name: 'read',
        status: 'running',
      },
    });
    expect(projectTranscriptForRender(projection).items).toMatchObject([
      {
        kind: 'message',
        messageId: 'assistant-live',
        associatedToolCallIds: ['call-live'],
        preparing: false,
      },
      { kind: 'tool', toolCallId: 'call-live', status: 'running' },
    ]);
    const items = toTranscriptEntries(projection);
    expect(items).toMatchObject([
      { key: 'assistant-live', entry: { kind: 'assistant' } },
      { entry: { kind: 'tool', status: 'running' }, tool: { name: 'read' } },
    ]);
  });

  it('keeps live multi-turn tools in the same group as reloaded history', () => {
    let projection = hydrateTranscript([], 's1');
    const reduce = (event: Parameters<typeof reduceTranscriptEvent>[1]) => {
      projection = reduceTranscriptEvent(projection, event);
    };
    reduce({
      type: 'message.finished',
      sessionId: 's1',
      message: {
        messageId: 'assistant-1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Inspecting the workspace.' },
          { type: 'toolCall', id: 'call-1', name: 'read' },
          { type: 'toolCall', id: 'call-2', name: 'bash' },
        ],
      },
    });
    for (const [toolCallId, name] of [
      ['call-1', 'read'],
      ['call-2', 'bash'],
    ] as const)
      reduce({
        type: 'tool.finished',
        sessionId: 's1',
        tool: { toolCallId, name, result: 'done', status: 'completed' },
      });
    for (const toolCallId of ['call-1', 'call-2'])
      reduce({
        type: 'message.finished',
        sessionId: 's1',
        message: {
          messageId: `result-${toolCallId}`,
          role: 'toolResult',
          content: [{ type: 'text', text: 'done' }],
        },
      });
    reduce({
      type: 'message.finished',
      sessionId: 's1',
      message: {
        messageId: 'assistant-2',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '**Checking the timestamp**' },
          { type: 'thinking', thinking: '   ' },
          { type: 'toolCall', id: 'call-3', name: 'bash' },
        ],
      },
    });
    reduce({
      type: 'tool.finished',
      sessionId: 's1',
      tool: {
        toolCallId: 'call-3',
        name: 'bash',
        result: 'done',
        status: 'completed',
      },
    });

    const items = toTranscriptEntries(projection);
    expect(items.some(({ entry }) => entry.kind === 'other')).toBe(false);
    expect(items.find(({ key }) => key === 'assistant-2')?.thinking).toEqual([
      '**Checking the timestamp**',
    ]);
    expect(
      projectActivityGroups(items.map(({ entry }) => entry)),
    ).toMatchObject([
      {
        title: 'Inspecting the workspace',
        toolCount: 3,
        status: 'complete',
      },
    ]);
  });

  it('uses semantic toolCallIds after compatibility filtering for preamble titles', () => {
    const items = toTranscriptEntries([
      {
        type: 'message',
        message: {
          role: 'assistant',
          messageId: 'assistant-live',
          toolCallIds: ['call-live'],
          content: [{ type: 'text', text: 'Inspecting the workspace.' }],
          __dashboardStreaming: true,
        },
      },
      {
        type: 'tool',
        tool: { toolCallId: 'call-live', name: 'read', status: 'pending' },
      },
      { type: 'session_info', id: 'metadata' },
      {
        type: 'custom_message',
        customType: 'notice',
        display: true,
        content: 'keep boundary',
      },
    ]);
    const assistant = items.find(({ entry }) => entry.kind === 'assistant');
    expect(assistant?.entry).toMatchObject({
      title: 'Inspecting the workspace',
      titleKind: 'preamble',
    });
    expect(assistant?.preparing).toBeUndefined();
    expect(
      items.some(
        ({ raw }) => (raw as { type?: string })?.type === 'session_info',
      ),
    ).toBe(false);
    expect(
      items.some(
        ({ raw }) => (raw as { type?: string })?.type === 'custom_message',
      ),
    ).toBe(true);
    expect(
      projectActivityGroups(items.map(({ entry }) => entry))[0]?.status,
    ).toBe('live');
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
    expect(toolOutcome({ kind: 'tool', status: 'complete' })).toBe('success');
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
