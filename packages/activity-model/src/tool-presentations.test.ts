import { describe, expect, it } from 'vitest';
import {
  backgroundPresentation,
  customToolKind,
  delegateChangesPresentation,
  delegateGatePresentation,
  delegatePresentation,
  fetchContentPresentation,
  getSearchContentPresentation,
  todoPresentation,
  todoResultIsRedundant,
  webSearchPresentation,
} from './tool-presentations.js';

describe('custom tool presentation kinds', () => {
  it('maps every registered custom tool name onto a presenter kind', () => {
    expect(customToolKind('web_search')).toBe('web_search');
    expect(customToolKind('search_web')).toBe('web_search');
    expect(customToolKind('fetch_content')).toBe('fetch_content');
    expect(customToolKind('get_search_content')).toBe('get_search_content');
    expect(customToolKind('delegate')).toBe('delegate');
    expect(customToolKind('delegates')).toBe('delegate');
    expect(customToolKind('delegate_jobs')).toBe('delegate_jobs');
    expect(customToolKind('delegate_changes')).toBe('delegate_changes');
    expect(customToolKind('delegate_gate')).toBe('delegate_gate');
    expect(customToolKind('background')).toBe('background');
    for (const name of [
      'background_start',
      'background_peek',
      'background_list',
      'background_stop',
      'background_watch',
      'background_unwatch',
    ])
      expect(customToolKind(name)).toBe('background');
    expect(customToolKind('todo')).toBe('todo');
    expect(customToolKind('tasks')).toBe('todo');
    expect(customToolKind('todo_list')).toBe('todo');
    expect(customToolKind('todo_update')).toBe('todo');
    expect(customToolKind('todo_remove')).toBe('todo');
    expect(customToolKind('delegate_start')).toBe('delegate');
    expect(customToolKind('delegate_continue')).toBe('delegate');
    expect(customToolKind('read')).toBeUndefined();
    expect(customToolKind('bash')).toBeUndefined();
  });

  it('reads the high-signal arguments each presenter needs', () => {
    expect(
      webSearchPresentation({
        queries: ['alpha', 'beta'],
        recencyFilter: 'week',
        domainFilter: ['example.com'],
        includeContent: true,
      }),
    ).toEqual({
      queries: ['alpha', 'beta'],
      recencyFilter: 'week',
      domainCount: 1,
      includeContent: true,
    });
    expect(fetchContentPresentation({ urls: ['https://example.com'] })).toEqual(
      {
        urls: ['https://example.com'],
      },
    );
    expect(
      getSearchContentPresentation({
        contentId: 'content-1',
        offset: 120,
        maxChars: 4000,
      }),
    ).toMatchObject({ contentId: 'content-1', offset: 120, maxChars: 4000 });
    expect(
      delegatePresentation({
        id: 'review-queue',
        task: 'Inspect the queue',
        route: 'quick',
        scope: ['packages/activity-model'],
      }),
    ).toEqual({
      name: 'review-queue',
      task: 'Inspect the queue',
      route: 'quick',
      scope: ['packages/activity-model'],
      continuation: undefined,
      taskCount: 0,
    });
    expect(
      delegatePresentation({
        continue: 'review-queue@2',
        task: 'Address feedback',
        route: 'quick',
        scope: ['src'],
      }),
    ).toMatchObject({
      continuation: 'review-queue@2',
      task: 'Address feedback',
      scope: ['src'],
    });
    expect(
      backgroundPresentation(
        { title: 'dev', command: 'pnpm dev' },
        undefined,
        new Map(),
        'background_start',
      ),
    ).toMatchObject({ action: 'start', title: 'dev', command: 'pnpm dev' });
    expect(
      backgroundPresentation({
        action: 'watch',
        id: 'bg-1',
        watch: [
          { contains: ' ready ', stream: 'stdout', timeout_seconds: 60 },
          null,
          { contains: 42 },
        ],
      }),
    ).toMatchObject({
      id: 'bg-1',
      watches: [{ contains: ' ready ', stream: 'stdout', timeoutSeconds: 60 }],
      watchIds: [],
    });
    expect(
      backgroundPresentation({ action: 'unwatch', watch_ids: ['w-1'] })
        .watchIds,
    ).toEqual(['w-1']);
    const titles = new Map([
      ['bg-1', 'Dev server'],
      ['bg-2', 'Build'],
    ]);
    for (const action of ['watch', 'unwatch', 'peek']) {
      expect(
        backgroundPresentation({ action, id: 'bg-1' }, undefined, titles)
          .target,
      ).toBe('Dev server');
      expect(backgroundPresentation({ action, id: 'unknown' }).target).toBe(
        'Background process',
      );
    }
    expect(
      backgroundPresentation(
        { action: 'stop', ids: ['bg-1', 'bg-2'] },
        undefined,
        titles,
      ).target,
    ).toBe('Dev server, Build');
    expect(
      backgroundPresentation(
        { action: 'peek', id: 'bg-1' },
        { details: { process: { id: 'bg-1', title: 'Current title' } } },
        titles,
      ).target,
    ).toBe('Current title');
    expect(
      todoPresentation({
        action: 'batch',
        operations: [
          { action: 'done', id: 'H4', notes: 'Coordinator suite passed.' },
          { action: 'start', id: 'H5' },
        ],
      }),
    ).toMatchObject({
      action: 'batch',
      operationCount: 2,
      operations: [
        {
          action: 'done',
          id: 'H4',
          notes: 'Coordinator suite passed.',
        },
        { action: 'start', id: 'H5' },
      ],
    });
    expect(
      todoResultIsRedundant(
        {
          action: 'batch',
          operations: [
            { action: 'done', id: 'H4' },
            { action: 'start', id: 'H5' },
          ],
        },
        'done H4; start H5',
      ),
    ).toBe(true);
    expect(
      todoResultIsRedundant(
        {
          action: 'batch',
          operations: [{ action: 'add', text: 'Write tests' }],
        },
        'added T3',
      ),
    ).toBe(false);
    expect(
      todoPresentation({
        action: 'replace',
        tasks: [
          {
            id: 'H4',
            text: 'Ship presenters',
            status: 'doing',
            notes: 'Dashboard inspectors',
            depends_on: ['H3'],
          },
          { id: 'H5', text: 'Follow-up review' },
        ],
      }),
    ).toMatchObject({
      action: 'replace',
      tasks: [
        {
          id: 'H4',
          text: 'Ship presenters',
          status: 'doing',
          notes: 'Dashboard inspectors',
          dependsOn: ['H3'],
        },
        { id: 'H5', text: 'Follow-up review' },
      ],
    });
    expect(
      todoResultIsRedundant(
        {
          action: 'replace',
          tasks: [{ id: 'H4', text: 'Ship presenters' }],
        },
        'replaced with 1 tasks',
      ),
    ).toBe(true);
    expect(
      todoPresentation(
        {
          changes: [
            {
              id: 'H4',
              text: 'Ship presenters',
              status: 'doing',
              priority: 'high',
              notes: 'Focused coordinator suite passed.',
              depends_on: ['H3'],
            },
          ],
        },
        'todo_update',
      ),
    ).toMatchObject({
      action: 'update',
      operationCount: 1,
      operations: [
        {
          action: 'upsert',
          id: 'H4',
          text: 'Ship presenters',
          status: 'doing',
          priority: 'high',
          notes: 'Focused coordinator suite passed.',
          dependsOn: ['H3'],
        },
      ],
    });
    expect(todoPresentation({ include_done: true }, 'todo_list')).toMatchObject(
      { action: 'list', includeDone: true },
    );
    expect(
      todoPresentation({ ids: ['H4', 'H5'] }, 'todo_remove'),
    ).toMatchObject({
      action: 'remove',
      operationCount: 2,
      operations: [
        { action: 'remove', id: 'H4' },
        { action: 'remove', id: 'H5' },
      ],
    });
    expect(todoResultIsRedundant({ action: 'done', id: 'H4' }, 'done H4')).toBe(
      true,
    );
    expect(
      todoResultIsRedundant(
        { action: 'done', id: 'H4' },
        'cleared 2 completed/dropped tasks',
      ),
    ).toBe(false);
    expect(
      delegateChangesPresentation({
        action: 'review',
        node: 'implementation',
        incremental: true,
        paths: ['src/a.ts'],
        patchBudget: 4000,
      }),
    ).toMatchObject({
      action: 'review',
      id: 'implementation',
      incremental: true,
      paths: ['src/a.ts'],
      patchBudget: 4000,
    });
    expect(
      delegateGatePresentation({
        mode: 'all',
        delegates: ['audit-a', 'audit-b'],
        delivery: 'idle',
      }),
    ).toEqual({
      mode: 'all',
      references: ['audit-a', 'audit-b'],
      delivery: 'idle',
    });
  });
});
