import { describe, expect, it } from 'vitest';
import {
  backgroundPresentation,
  customToolKind,
  delegateBranchesPresentation,
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
    expect(customToolKind('delegate_branches')).toBe('delegate_branches');
    expect(customToolKind('delegate_wake')).toBe('delegate_wake');
    expect(customToolKind('background')).toBe('background');
    expect(customToolKind('todo')).toBe('todo');
    expect(customToolKind('tasks')).toBe('todo');
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
    expect(fetchContentPresentation({ url: 'https://example.com' })).toEqual({
      urls: ['https://example.com'],
    });
    expect(
      getSearchContentPresentation({
        responseId: 'ws_1',
        heading: 'Results',
        queryIndex: 0,
      }),
    ).toMatchObject({ responseId: 'ws_1', heading: 'Results', queryIndex: 0 });
    expect(
      delegatePresentation({
        name: 'Review',
        task: 'Inspect the queue',
        route: 'quick',
      }),
    ).toEqual({
      name: 'Review',
      task: 'Inspect the queue',
      route: 'quick',
      continuation: undefined,
      taskCount: 0,
    });
    expect(
      backgroundPresentation({
        action: 'start',
        title: 'dev',
        command: 'pnpm dev',
      }),
    ).toMatchObject({ action: 'start', title: 'dev', command: 'pnpm dev' });
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
      todoPresentation({
        action: 'done',
        id: 'H4',
        notes: 'Focused coordinator suite passed.',
      }),
    ).toMatchObject({
      action: 'done',
      id: 'H4',
      notes: 'Focused coordinator suite passed.',
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
      delegateBranchesPresentation({
        action: 'review',
        id: 'wt-1',
        incremental: true,
        paths: ['src/a.ts'],
        patchBudget: 4000,
      }),
    ).toMatchObject({
      action: 'review',
      id: 'wt-1',
      incremental: true,
      paths: ['src/a.ts'],
      patchBudget: 4000,
    });
  });
});
