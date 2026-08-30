import {
  type DelegateStatus,
  type ExtensionSurface,
  TASKS_RENDERER_ID,
  type TaskStateViewModel,
} from '@pi-dashboard/extension-contributions';
import type {
  AuthoritativeSessionSnapshot,
  BrowserSnapshot,
  RuntimeSnapshot,
  SessionActiveOverlay,
  SessionIndexEntry,
} from '@pi-dashboard/protocol';
import type { Page } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

export const VISUAL_DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;
export const VISUAL_PIXEL_VIEWPORT = { width: 393, height: 851 } as const;

const VISUAL_TIMESTAMP = Date.parse('2026-08-30T12:00:00.000Z');
const VISUAL_SERVER_ID = 'visual-state-fixture';
const VISUAL_CWD = '/workspace/dashboard';

export type VisualStateScenario = {
  readonly name: string;
  readonly route: string;
  readonly snapshot: BrowserSnapshot;
  readonly sessionSnapshot?: AuthoritativeSessionSnapshot;
};

type SessionScenarioOptions = {
  name: string;
  title: string;
  liveState: RuntimeSnapshot['liveState'];
  online?: boolean;
  lastError?: string;
  entries?: readonly unknown[];
  active?: SessionActiveOverlay;
  extensionSurfaces?: readonly ExtensionSurface[];
};

const model = {
  provider: 'openai',
  model: 'gpt-5.6-sol',
  thinking: 'medium',
};

function sessionMetadata(
  id: string,
  title: string,
  runtimeId: string,
): SessionIndexEntry {
  return {
    id,
    file: `${VISUAL_CWD}/.pi/${id}.jsonl`,
    cwd: VISUAL_CWD,
    title,
    startedAt: VISUAL_TIMESTAMP - 60_000,
    updatedAt: VISUAL_TIMESTAMP,
    activeRuntimeId: runtimeId,
    entryCount: 8,
  };
}

function runtimeSnapshot(
  id: string,
  metadata: SessionIndexEntry,
  options: SessionScenarioOptions,
): RuntimeSnapshot {
  return {
    runtimeId: id,
    ownership: 'managed',
    pid: 42,
    cwd: VISUAL_CWD,
    liveState: options.liveState,
    online: options.online ?? true,
    ...(options.lastError ? { lastError: options.lastError } : {}),
    model,
    modelCatalog: [
      {
        ...model,
        name: 'Sol',
      },
    ],
    thinkingLevels: ['off', 'medium', 'high'],
    composerCommands: [
      {
        name: 'review',
        description: 'Review the current changes',
        source: 'prompt',
      },
    ],
    contextUsage: { tokens: 48_000, contextWindow: 200_000, percent: 24 },
    session: { id: metadata.id, title: metadata.title, entries: [] },
    ...(options.extensionSurfaces
      ? { extensionSurfaces: options.extensionSurfaces }
      : {}),
  };
}

function sessionSnapshot(
  metadata: SessionIndexEntry,
  entries: readonly unknown[],
  active: SessionActiveOverlay = {
    messages: [],
    tools: [],
    delegates: [],
    truncated: false,
  },
): AuthoritativeSessionSnapshot {
  return {
    metadata,
    entries,
    entriesComplete: true,
    serverId: VISUAL_SERVER_ID,
    cursor: 1,
    active,
    completeThroughCursor: true,
  };
}

function scenario(options: SessionScenarioOptions): VisualStateScenario {
  const sessionId = `${options.name}-session`;
  const runtimeId = `${options.name}-runtime`;
  const metadata = sessionMetadata(sessionId, options.title, runtimeId);
  const runtime = runtimeSnapshot(runtimeId, metadata, options);
  return {
    name: options.name,
    route: `/sessions/${sessionId}`,
    snapshot: {
      serverId: VISUAL_SERVER_ID,
      revision: 1,
      cursor: 1,
      runtimes: [runtime],
      sessions: [metadata],
      unread: [],
    },
    sessionSnapshot: sessionSnapshot(
      metadata,
      options.entries ?? [],
      options.active,
    ),
  };
}

const taskState: TaskStateViewModel = {
  version: 1,
  tasks: [
    {
      id: 'T1',
      text: 'Review the dashboard layout',
      status: 'doing',
      dependsOn: [],
      priority: 'high',
      createdAt: VISUAL_TIMESTAMP - 30_000,
      updatedAt: VISUAL_TIMESTAMP - 10_000,
    },
    {
      id: 'T2',
      text: 'Capture visual baselines',
      status: 'todo',
      dependsOn: ['T1'],
      priority: 'normal',
      createdAt: VISUAL_TIMESTAMP - 20_000,
      updatedAt: VISUAL_TIMESTAMP - 5_000,
    },
  ],
  stats: { total: 2, active: 1, done: 0, blocked: 0, ready: 1 },
};

const delegateStatus: DelegateStatus = {
  id: 'delegate-review',
  runId: 'delegate-review-run',
  sessionId: 'working-session',
  lineageId: 'delegate-review-lineage',
  name: 'Review worker',
  kind: 'background',
  state: 'running',
  createdAt: VISUAL_TIMESTAMP - 25_000,
  startedAt: VISUAL_TIMESTAMP - 20_000,
  allowWrites: false,
  isolation: 'shared',
  context: 'continuation',
  details: {
    task: 'Review the running implementation.',
    setup: { cwd: VISUAL_CWD, isolation: 'shared' },
    runConfig: {
      scope: ['apps/dashboard-web'],
      parentContextNote: 'Keep the review focused.',
    },
    truncated: false,
  },
  activity: {
    type: 'tool',
    label: 'Inspecting visual states',
    status: 'running',
  },
  transcript: [
    {
      id: 'delegate-review-task',
      type: 'task',
      label: 'Review the running implementation.',
    },
  ],
};

const workingSurfaces: readonly ExtensionSurface[] = [
  {
    id: 'tasks.current',
    rendererId: TASKS_RENDERER_ID,
    placement: 'composer',
    viewModel: taskState,
  },
];

const workingEntries: readonly unknown[] = [
  {
    type: 'message',
    id: 'working-user',
    message: {
      role: 'user',
      timestamp: VISUAL_TIMESTAMP - 25_000,
      content: [{ type: 'text', text: 'Review the dashboard layout.' }],
    },
  },
  {
    type: 'message',
    id: 'working-assistant',
    message: {
      role: 'assistant',
      timestamp: VISUAL_TIMESTAMP - 20_000,
      content: [
        { type: 'thinking', thinking: 'Checking the project surfaces.' },
        { type: 'thinking', thinking: 'Reviewing the transcript hierarchy.' },
        { type: 'text', text: 'Inspecting the dashboard surfaces.' },
        {
          type: 'toolCall',
          id: 'working-read',
          name: 'read',
          arguments: { path: 'apps/dashboard-web/src/App.tsx' },
        },
        {
          type: 'toolCall',
          id: 'working-search',
          name: 'grep',
          arguments: { pattern: 'visual state', path: 'apps/dashboard-web' },
        },
      ],
    },
  },
  {
    type: 'message',
    id: 'working-assistant-middle',
    message: {
      role: 'assistant',
      timestamp: VISUAL_TIMESTAMP - 18_000,
      content: [
        {
          type: 'thinking',
          thinking:
            'Comparing the mobile layout.\nChecking the disclosure behavior.',
        },
        {
          type: 'toolCall',
          id: 'working-style-read',
          name: 'read',
          arguments: { path: 'apps/dashboard-web/src/styles.css' },
        },
        {
          type: 'toolCall',
          id: 'working-edit',
          name: 'edit',
          arguments: { path: 'apps/dashboard-web/src/App.tsx', edits: [{}] },
        },
      ],
    },
  },
  {
    type: 'message',
    id: 'working-assistant-tail',
    message: {
      role: 'assistant',
      timestamp: VISUAL_TIMESTAMP - 16_000,
      content: [
        { type: 'thinking', thinking: 'Preparing the visual review.' },
        {
          type: 'toolCall',
          id: 'working-test',
          name: 'bash',
          arguments: { command: 'bun test' },
        },
      ],
    },
  },
  {
    type: 'message',
    id: 'working-read-result',
    message: {
      role: 'toolResult',
      toolCallId: 'working-read',
      content: [{ type: 'text', text: 'App.tsx contents' }],
      isError: false,
    },
  },
  {
    type: 'message',
    id: 'working-search-result',
    message: {
      role: 'toolResult',
      toolCallId: 'working-search',
      content: [{ type: 'text', text: 'visual-state-fixtures.ts' }],
      isError: false,
    },
  },
  {
    type: 'message',
    id: 'working-style-read-result',
    message: {
      role: 'toolResult',
      toolCallId: 'working-style-read',
      content: [{ type: 'text', text: 'Dashboard style imports' }],
      isError: false,
    },
  },
  {
    type: 'message',
    id: 'working-edit-result',
    message: {
      role: 'toolResult',
      toolCallId: 'working-edit',
      content: [{ type: 'text', text: 'Updated App.tsx' }],
      isError: false,
    },
  },
  {
    type: 'message',
    id: 'working-test-result',
    message: {
      role: 'toolResult',
      toolCallId: 'working-test',
      content: [{ type: 'text', text: 'All tests passed' }],
      isError: false,
    },
  },
  {
    type: 'custom',
    customType: 'lean-todo',
    data: {
      kind: 'snapshot',
      state: {
        tasks: [
          { id: 'T1', text: 'Review the dashboard layout', status: 'doing' },
          { id: 'T2', text: 'Capture visual baselines', status: 'todo' },
        ],
      },
    },
  },
  {
    type: 'custom_message',
    customType: 'delegate-job-result',
    display: true,
    content: 'Review worker is still running.',
    details: {
      jobs: [{ name: 'Review worker', state: 'running' }],
    },
  },
  {
    type: 'message',
    id: 'working-follow-up',
    message: {
      role: 'assistant',
      timestamp: VISUAL_TIMESTAMP - 5_000,
      content: [{ type: 'text', text: 'The review is still in progress.' }],
    },
  },
];

export function buildEmptyHomeScenario(): VisualStateScenario {
  return {
    name: 'empty-home',
    route: '/',
    snapshot: {
      serverId: VISUAL_SERVER_ID,
      revision: 1,
      cursor: 1,
      runtimes: [],
      sessions: [],
      unread: [],
    },
  };
}

export function buildWorkingScenario(): VisualStateScenario {
  const base = scenario({
    name: 'working',
    title: 'Review dashboard layout',
    liveState: 'working',
    entries: workingEntries,
    extensionSurfaces: workingSurfaces,
  });
  const runtime = base.snapshot.runtimes[0];
  const active: SessionActiveOverlay = {
    runtimeId: runtime?.runtimeId,
    runtimeEpoch: 'working-epoch',
    runtimeSeq: 1,
    liveState: 'working',
    messages: [],
    tools: [],
    delegates: [
      {
        runId: delegateStatus.runId,
        sessionId: 'delegate-review-session',
        lineageId: delegateStatus.lineageId,
        name: delegateStatus.name,
        kind: delegateStatus.kind,
        state: delegateStatus.state,
        createdAt: delegateStatus.createdAt,
        startedAt: delegateStatus.startedAt,
        allowWrites: delegateStatus.allowWrites,
        details: delegateStatus.details,
        transcript: delegateStatus.transcript ?? [],
      },
    ],
    truncated: false,
  };
  const hydrated = base.sessionSnapshot;
  if (!hydrated) throw new Error('Working scenario session is missing.');
  return {
    ...base,
    sessionSnapshot: {
      ...hydrated,
      active,
    },
  };
}

export function buildWaitingScenario(): VisualStateScenario {
  return scenario({
    name: 'waiting',
    title: 'Waiting for approval',
    liveState: 'waiting',
    entries: [
      {
        type: 'message',
        id: 'waiting-user',
        message: {
          role: 'user',
          timestamp: VISUAL_TIMESTAMP - 20_000,
          content: [{ type: 'text', text: 'Prepare the release checklist.' }],
        },
      },
      {
        type: 'message',
        id: 'waiting-assistant',
        message: {
          role: 'assistant',
          timestamp: VISUAL_TIMESTAMP - 10_000,
          content: [
            { type: 'text', text: 'The checklist is ready for your review.' },
          ],
        },
      },
    ],
    active: {
      liveState: 'waiting',
      messages: [],
      tools: [],
      delegates: [],
      truncated: false,
    },
  });
}

export function buildFailedScenario(): VisualStateScenario {
  return scenario({
    name: 'failed',
    title: 'Failed release check',
    liveState: 'failed',
    lastError: 'Release check exited with code 1.',
    entries: [
      {
        type: 'message',
        id: 'failed-assistant',
        message: {
          role: 'assistant',
          timestamp: VISUAL_TIMESTAMP - 8_000,
          content: [
            { type: 'text', text: 'Running the release check.' },
            {
              type: 'toolCall',
              id: 'failed-command',
              name: 'bash',
              arguments: { command: 'bun test' },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'failed-result',
        message: {
          role: 'toolResult',
          toolCallId: 'failed-command',
          content: [
            { type: 'text', text: 'Release check exited with code 1.' },
          ],
          isError: true,
        },
      },
    ],
  });
}

export function buildOfflineScenario(): VisualStateScenario {
  return scenario({
    name: 'offline',
    title: 'Offline diagnostics',
    liveState: 'idle',
    online: false,
    lastError: 'Runtime disconnected.',
    entries: [
      {
        type: 'message',
        id: 'offline-message',
        message: {
          role: 'user',
          timestamp: VISUAL_TIMESTAMP - 5_000,
          content: [{ type: 'text', text: 'Reconnect the runtime.' }],
        },
      },
    ],
  });
}

export async function installVisualStateScenario(
  page: Page,
  visualScenario: VisualStateScenario,
): Promise<void> {
  await page.clock.setFixedTime(VISUAL_TIMESTAMP + 90 * 60_000);
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/settings', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ modelDisplayPreferences: {} }),
    }),
  );
  await page.route('**/api/threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/session-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route(/\/api\/sessions\/[^/]+\/delegate-history$/u, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: 2,
        sessionId: new URL(route.request().url()).pathname.split('/').at(-2),
        groups: [],
      }),
    }),
  );
  await installDashboardBootstrap(page, visualScenario.snapshot, {
    ...(visualScenario.sessionSnapshot
      ? {
          sessionSnapshot: visualScenario.sessionSnapshot as unknown as Record<
            string,
            unknown
          >,
        }
      : {}),
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(visualScenario.route);
}
