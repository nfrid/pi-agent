import {
  hydrateTranscript,
  projectTranscriptForRender,
  reduceTranscriptEvent,
  STEERING_MESSAGE_MARKER_TYPE,
} from '@pi-dashboard/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { toolOutcome, toTranscriptEntries } from '../transcript';
import {
  activityStepParts,
  buildTranscriptLandmarks,
  buildTranscriptToolStreams,
  buildVirtualTranscriptRows,
  displayActivityPath,
  mergeTranscriptLandmarks,
  parseSkillInvocation,
  preserveVirtualScrollOffset,
  restoreVirtualBottom,
  toolStreamMetadataLabel,
  transcriptItemTimestamp,
  transcriptRoleLabel,
} from './transcript';
import { SkillInvocationView, TranscriptEntry } from './transcript/entries';
import { TranscriptToolStream } from './transcript/tool-stream';
import { LivePauseEvent } from './transcript/view';

describe('activity row views and virtual transcript construction', () => {
  it('projects skill protocol envelopes as compact invocation data', () => {
    expect(
      parseSkillInvocation(
        '<skill name="browser" location="/skills/browser/SKILL.md">\nReferences are relative to /skills/browser.\n\nUse the browser.\n</skill>\n\nInspect the page',
      ),
    ).toEqual({
      name: 'browser',
      location: '/skills/browser/SKILL.md',
      instructions:
        'References are relative to /skills/browser.\n\nUse the browser.',
      request: 'Inspect the page',
    });
    expect(parseSkillInvocation('ordinary user message')).toBeUndefined();
  });

  it('keeps the user request visible outside collapsed skill details', () => {
    const html = renderToStaticMarkup(
      createElement(SkillInvocationView, {
        invocation: {
          name: 'browser',
          instructions: 'Use the browser.',
          request: 'Inspect the page',
        },
      }),
    );

    expect(html).toMatch(
      /<\/details><div class="skill-invocation-request"><strong>Request<\/strong>.*Inspect the page/u,
    );
  });

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
        data: { timestamp: 100, text: 'Please redirect the current work.' },
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

  it('preserves boundaries between assistant text blocks', () => {
    const [item] = toTranscriptEntries([
      {
        type: 'message',
        id: 'assistant-waiting',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Waiting for the final review.' },
            { type: 'text', text: 'Deployment will resume automatically.' },
          ],
        },
      },
    ]);

    expect(item?.text).toBe(
      'Waiting for the final review.\n\nDeployment will resume automatically.',
    );
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
    expect(item && transcriptItemTimestamp(item)).toBe(
      '2026-08-05T18:42:00.000Z',
    );
  });

  it('appends live landmarks missing from the indexed outline', () => {
    const loaded = buildTranscriptLandmarks(
      toTranscriptEntries([
        {
          type: 'message',
          id: 'indexed-user',
          message: { role: 'user', content: 'Loaded historical label' },
        },
        {
          type: 'message',
          id: 'live-user',
          message: { role: 'user', content: 'New live request' },
        },
      ]),
    );

    expect(
      mergeTranscriptLandmarks(loaded, [
        {
          id: 'indexed-user',
          kind: 'user',
          label: 'Indexed historical label',
          ordinal: 10,
        },
      ]),
    ).toMatchObject([
      { key: 'indexed-user', label: 'Indexed historical label' },
      { key: 'live-user', label: 'New live request' },
    ]);
  });

  it('uses agent labels', () => {
    expect(transcriptRoleLabel('assistant')).toBe('agent');
    expect(transcriptRoleLabel('user')).toBe('user');
    expect(transcriptRoleLabel('assistant', 'steer')).toBe('steer');
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
      activityStepParts({
        name: 'bash',
        args: {
          command: 'git add . && git commit -m change',
          description: 'Stage and commit changes in the current repository',
        },
      }),
    ).toEqual({
      label:
        'Stage and commit changes in the current repository git add . && git commit -m change',
      action: 'Stage and commit changes in the current repository',
      argument: 'git add . && git commit -m change',
      described: true,
      role: 'command',
      state: 'complete',
    });
    expect(
      activityStepParts({
        name: 'bash',
        args: { command: 'echo fallback', description: 'x'.repeat(500) },
      }).label.length,
    ).toBeLessThanOrEqual(140);
    const compoundCommand =
      'rg -n "todo|otherstuff"\napps && rg -n "kind: other" packages; printf done';
    expect(
      activityStepParts({ name: 'bash', args: { command: compoundCommand } }),
    ).toMatchObject({
      argument:
        'rg -n "todo|otherstuff" apps && rg -n "kind: other" packages; printf done',
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
    expect(
      activityStepParts({
        name: 'delegate_jobs',
        args: { action: 'feedback', id: 'dj-1' },
      }),
    ).toMatchObject({
      label: 'Sending feedback to delegate job dj-1',
      action: 'Sending feedback to delegate job',
      argument: 'dj-1',
    });
    const longPath = `src/${'wide-segment/'.repeat(40)}dashboard.tsx`;
    expect(
      activityStepParts({ name: 'read', args: { path: longPath } }).argument,
    ).toBe(longPath);
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

  it('summarizes delegation, fetches, and file ranges usefully', () => {
    expect(
      activityStepParts({
        name: 'delegate_changes',
        args: {
          action: 'drop',
          node: 'reconnect-race-fix',
        },
      }),
    ).toMatchObject({
      action: 'Dropping delegate changes',
      argument: 'reconnect-race-fix',
      role: 'command',
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

  it('shows git-like line counts for write and edit tools', () => {
    expect(
      activityStepParts({
        name: 'write',
        args: { path: 'src/new.ts', content: 'one\ntwo\nthree\n' },
      }),
    ).toMatchObject({
      action: 'Writing',
      argument: 'src/new.ts',
      lineChanges: { added: 3, changed: 0, removed: 0 },
    });
    expect(
      activityStepParts({
        name: 'edit',
        args: {
          path: 'src/App.tsx',
          edits: [
            {
              oldText: 'same\nold one\nold two\ntail',
              newText: 'same\nnew one\nnew two\nnew three\ntail',
            },
            { oldText: 'remove me\nand me', newText: '' },
            {
              oldText: 'before\nafter',
              newText: 'before\ninserted\nafter',
            },
          ],
        },
      }),
    ).toMatchObject({
      action: 'Editing',
      argument: 'src/App.tsx',
      lineChanges: { added: 2, changed: 2, removed: 2 },
    });
  });

  it('summarizes a flat tool stream without status or kind language', () => {
    const html = renderToStaticMarkup(
      createElement(TranscriptToolStream, {
        items: toTranscriptEntries([
          { type: 'tool', tool: { toolCallId: 'call-1', name: 'read' } },
          { type: 'tool', tool: { toolCallId: 'call-2', name: 'grep' } },
          { type: 'tool', tool: { toolCallId: 'call-3', name: 'edit' } },
          {
            type: 'tool',
            tool: { toolCallId: 'call-4', name: 'bash', isError: true },
          },
        ]),
        expanded: false,
        onToggle: () => undefined,
      }),
    );
    expect(html).toContain('Show 1 earlier call');
    expect(html).toContain('4 calls');
    expect(html).not.toContain('activity-group');
    expect(html).not.toContain('needs input');
  });

  it('aggregates flat stream metadata without a group kind or status', () => {
    expect(
      toolStreamMetadataLabel([
        { name: 'write', args: { content: 'one\ntwo\n' } },
        {
          name: 'edit',
          args: { edits: [{ oldText: 'old', newText: 'new\nextra' }] },
        },
        { name: 'bash', args: {}, data: { durationMs: 2_500 }, isError: true },
      ]),
    ).toBe('3 calls · +3 ~1 · 3s · 1 failed');
  });

  it('keeps delegate feedback visible between flat tool streams', () => {
    const items = toTranscriptEntries([
      { type: 'tool', tool: { toolCallId: 'call-1', name: 'read' } },
      {
        type: 'custom_message',
        customType: 'delegate-control',
        display: false,
        content:
          'Parent feedback (address this at this checkpoint):\nUse the corrected API.',
      },
      { type: 'tool', tool: { toolCallId: 'call-2', name: 'bash' } },
    ]);
    const feedback = items.find(
      (item) => item.event?.kind === 'delegate-feedback',
    );
    expect(feedback).toBeDefined();
    if (!feedback) return;
    expect(buildTranscriptToolStreams(items)).toMatchObject([
      { start: 0, end: 0 },
      { start: 2, end: 2 },
    ]);
    expect(
      renderToStaticMarkup(createElement(TranscriptEntry, { item: feedback })),
    ).toContain('Parent feedback');
  });

  it('builds virtual flat rows without swallowing non-tool events', () => {
    const items = toTranscriptEntries([
      { type: 'tool', tool: { toolCallId: 'call-1', name: 'read' } },
      {
        type: 'custom_message',
        customType: 'delegate-control',
        display: false,
        content:
          'Parent feedback (address this at this checkpoint):\nReview it.',
      },
      { type: 'tool', tool: { toolCallId: 'call-2', name: 'bash' } },
    ]);
    expect(buildVirtualTranscriptRows(items)).toEqual([
      { kind: 'tool-stream', key: items[0]?.key, start: 0, end: 0 },
      { kind: 'entry', key: items[1]?.key, index: 1 },
      { kind: 'tool-stream', key: items[2]?.key, start: 2, end: 2 },
    ]);
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

  it('omits empty finished assistant envelopes while retaining standalone tools', () => {
    const items = toTranscriptEntries([
      {
        type: 'message',
        message: {
          role: 'assistant',
          messageId: 'assistant-empty',
          content: [],
          toolCallIds: ['call-1'],
        },
      },
      {
        type: 'tool',
        tool: { toolCallId: 'call-1', name: 'read', status: 'complete' },
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      entry: { kind: 'tool' },
      tool: { toolCallId: 'call-1', name: 'read' },
    });
  });

  it('shows hidden delegate feedback without exposing other provider context', () => {
    const items = toTranscriptEntries([
      {
        type: 'custom_message',
        customType: 'delegate-control',
        display: false,
        content:
          'Parent feedback (address this at this checkpoint):\nUse the corrected API.',
      },
      {
        type: 'custom_message',
        customType: 'delegate-control',
        display: false,
        content: 'Malformed hidden delegate context',
      },
      {
        type: 'custom_message',
        customType: 'extension-context',
        display: false,
        content: 'Provider-only context',
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      entry: { kind: 'other', continuesGroup: true },
      event: {
        kind: 'delegate-feedback',
        label: 'Parent feedback',
        content: 'Use the corrected API.',
      },
    });
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
      items
        .filter((item) => item.event)
        .every(
          (item) =>
            item.entry.kind === 'other' && item.entry.continuesGroup === true,
        ),
    ).toBe(true);
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

  it('summarizes semantic delegate delivery without expanding the event', () => {
    const items = toTranscriptEntries([
      {
        type: 'custom_message',
        customType: 'delegate-wake-result',
        display: true,
        content:
          '# Reconnect Race Review success\n\nDelivered eagerly at the next safe parent boundary.',
        details: {
          sources: ['reconnect-race-review@1'],
          presentation: {
            origin: 'eager',
            condition: 'node',
            timing: 'safe',
            sources: [
              {
                identity: 'reconnect-race-review@1',
                logicalId: 'reconnect-race-review',
                state: 'success',
                route: 'luna-high',
                durationMs: 42_000,
              },
            ],
            outstanding: [],
          },
        },
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]?.event).toMatchObject({
      kind: 'delegate-result',
      label: 'Reconnect Race Review finished · eager · safe boundary',
      status: 'success',
      content: expect.stringContaining('Delivered eagerly'),
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

  it('keeps live multi-turn tools in canonical order after reloading history', () => {
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
    expect(buildTranscriptToolStreams(items)).toMatchObject([
      { start: 1, end: 2 },
      { start: 4, end: 4 },
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
      streaming: true,
      speaks: false,
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
    expect(buildTranscriptToolStreams(items)).toMatchObject([
      { start: 1, end: 1 },
    ]);
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
          details: {
            mode: 'single',
            runs: [],
          },
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
          details: {
            mode: 'single',
            runs: [],
          },
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
            { type: 'text', text: 'Reading the historical result.' },
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
          { type: 'text', text: 'Checking the failing command.' },
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
      tool: {
        result: {
          content: [{ type: 'text', text: 'ok' }],
          details: {
            runs: [],
          },
        },
      },
    });
    expect(failedTool).toMatchObject({
      entry: { kind: 'tool', status: 'error', isError: true },
    });
    expect(successful).toHaveLength(2);
    expect(failed).toHaveLength(2);
    expect(toolOutcome({ kind: 'tool', status: 'finished' })).toBe('success');
    expect(toolOutcome({ kind: 'tool', status: 'complete' })).toBe('success');
  });

  it('renders a fully reached pause as a transient transcript event', () => {
    const html = renderToStaticMarkup(
      createElement(LivePauseEvent, {
        runtime: {
          extensionSurfaces: [
            {
              id: 'runtime.pause-status',
              rendererId: 'runtime.pause-status',
              viewModel: {
                version: 1,
                phase: 'paused',
                delegateCount: 2,
                pausedAt: 12_345,
                label: 'Paused (with 2 delegates)',
              },
            },
          ],
        } as never,
      }),
    );
    expect(html).toContain('live-pause-event');
    expect(html).toContain('Paused (with 2 delegates)');
    expect(html).toContain('Continue paused runtime');
    expect(html).toContain('<svg');
    expect(html).toContain('pause-icon');
    expect(html).not.toContain('‖');
    expect(html).not.toContain('▶');
    expect(html).not.toContain('disabled');
  });

  it('does not render a transcript pause event before the safe boundary', () => {
    const html = renderToStaticMarkup(
      createElement(LivePauseEvent, {
        runtime: {
          extensionSurfaces: [
            {
              id: 'runtime.pause-status',
              rendererId: 'runtime.pause-status',
              viewModel: {
                version: 1,
                phase: 'pausing',
                delegateCount: 0,
                label: 'Pausing…',
              },
            },
          ],
        } as never,
      }),
    );
    expect(html).toBe('');
  });
});

describe('virtual transcript scroll preservation', () => {
  it('keeps the first visible row anchored while variable rows resize', () => {
    expect(preserveVirtualScrollOffset(240, 312, false)).toBe(-72);
  });

  it('does not fight bottom-stick scrolling after measurement', () => {
    expect(preserveVirtualScrollOffset(240, 312, true)).toBe(0);
  });

  it('restores the bottom after an expanded stream is measured', () => {
    expect(restoreVirtualBottom(2400, 720, true)).toBe(1680);
    expect(restoreVirtualBottom(2400, 720, false)).toBeUndefined();
  });
});
