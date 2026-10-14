import {
  NotificationEventSchema,
  type RuntimeSnapshot,
} from '@pi-dashboard/protocol';
import { Value } from 'typebox/value';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetadataStore } from '../metadata.js';
import type { PushSender } from '../push.js';
import type { RegistryChange } from '../runtime-registry.js';
import { NotificationService } from './notification-service.js';

const snapshot: RuntimeSnapshot = {
  runtimeId: 'runtime-replaced',
  ownership: 'external',
  pid: 1,
  cwd: '/tmp/project',
  liveState: 'idle',
  session: { id: 'session-replaced', entries: [] },
};

function goodbye(reason: string): RegistryChange {
  return {
    kind: 'event',
    runtimeId: snapshot.runtimeId,
    event: { type: 'runtime.goodbye', reason },
    snapshot,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('NotificationService runtime shutdowns', () => {
  it.each([
    'new',
    'resume',
    'fork',
  ])('does not notify for a %s session replacement', (reason) => {
    const addNotification = vi.fn();
    const notify = vi.fn(async () => undefined);
    const service = new NotificationService(
      { addNotification } as unknown as MetadataStore,
      { notify } as unknown as PushSender,
    );

    service.handle(goodbye(reason));

    expect(addNotification).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    'quit',
    'reload',
    'error',
    'new',
    'resume',
    'fork',
  ])('does not notify for a non-failed %s goodbye', (reason) => {
    const addNotification = vi.fn();
    const notify = vi.fn(async () => undefined);
    const service = new NotificationService(
      { addNotification } as unknown as MetadataStore,
      { notify } as unknown as PushSender,
    );

    service.handle(goodbye(reason));
    service.handle({
      ...goodbye(reason),
      snapshot: {
        ...snapshot,
        session: {
          id: 'delegate-unindexed',
          file: '/tmp/.delegate-sessions/delegate.jsonl',
          entries: [],
        },
      },
    });

    expect(addNotification).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    'quit',
    'reload',
    'other',
  ])('alerts only when a goodbye snapshot explicitly reports failure (%s)', (reason) => {
    const addNotification = vi.fn();
    const notify = vi.fn(async () => undefined);
    const service = new NotificationService(
      { addNotification } as unknown as MetadataStore,
      { notify } as unknown as PushSender,
    );

    service.handle({
      ...goodbye(reason),
      snapshot: {
        ...snapshot,
        liveState: 'failed',
        lastError: 'Failure detail',
      },
    });

    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'failed',
        title: 'Pi runtime failed',
        body: 'Failure detail',
        sessionId: snapshot.session.id,
      }),
    );
    expect(notify).toHaveBeenCalledOnce();
  });

  it('keeps true offline and failed runtime notifications', () => {
    const addNotification = vi.fn();
    const notify = vi.fn(async () => undefined);
    const service = new NotificationService(
      { addNotification } as unknown as MetadataStore,
      { notify } as unknown as PushSender,
    );

    service.handle({ kind: 'offline', snapshot });
    service.handle({
      kind: 'offline',
      snapshot: {
        ...snapshot,
        runtimeId: 'delegate-runtime',
        liveState: 'failed',
        session: { ...snapshot.session, id: 'delegate-session' },
      },
    });

    expect(addNotification).toHaveBeenCalledTimes(2);
    expect(
      addNotification.mock.calls.map(([notification]) => notification.kind),
    ).toEqual(['runtime-exited', 'failed']);
  });
});

describe('NotificationService settled turns', () => {
  function settledChange(
    entries: readonly unknown[],
    closure?: unknown,
  ): RegistryChange {
    return {
      kind: 'event',
      runtimeId: snapshot.runtimeId,
      event: {
        type: 'agent.settled',
        ...(closure === undefined ? {} : { closure }),
      } as Extract<RegistryChange, { kind: 'event' }>['event'],
      snapshot: {
        ...snapshot,
        projectId: 'project-1',
        session: {
          ...snapshot.session,
          name: 'Session display',
          entries,
        },
      },
    };
  }

  function serviceWithProjectAndThread(
    projectTitle = 'Project display',
    threadTitle = 'Thread display',
  ) {
    const addNotification = vi.fn();
    const notify = vi.fn(async () => undefined);
    const service = new NotificationService(
      {
        addNotification,
        orchestration: {
          getSessionThreadLink: () => ({ threadId: 'thread-1' }),
          getThread: () => ({ title: threadTitle }),
          getProject: () => ({ title: projectTitle }),
        },
      } as unknown as MetadataStore,
      { notify } as unknown as PushSender,
    );
    return { service, addNotification, notify };
  }

  const closure = {
    type: 'custom',
    customType: 'response-closure',
    data: {
      requestMessageId: 'user-current',
      finalMessageId: 'assistant-final',
      startedAt: 1,
      endedAt: 2,
    },
  };

  it('uses project and thread names with only the completed final answer', () => {
    vi.stubEnv('PI_DASHBOARD_NOTIFY_SETTLED', '1');
    const { service, addNotification } = serviceWithProjectAndThread();
    service.handle(
      settledChange(
        [
          {
            id: 'assistant-old',
            message: { role: 'assistant', content: 'Old answer' },
          },
          {
            id: 'assistant-thinking',
            message: {
              role: 'assistant',
              content: [{ type: 'thinking', thinking: 'Private thought' }],
            },
          },
          {
            id: 'assistant-interim',
            message: { role: 'assistant', content: 'Interim answer' },
          },
          {
            id: 'tool',
            message: { role: 'toolResult', content: 'Tool output' },
          },
          {
            id: 'assistant-final',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Final answer' },
                { type: 'toolCall', id: 'tool-call' },
              ],
            },
          },
        ],
        closure,
      ),
    );
    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'settled',
        title: 'Project display · Thread display',
        body: 'Final answer',
        runtimeId: snapshot.runtimeId,
        sessionId: snapshot.session.id,
      }),
    );
  });

  it.each([
    ['missing closure', [], undefined],
    ['missing final entry', [], closure],
    [
      'empty final text',
      [
        {
          id: 'assistant-final',
          message: { role: 'assistant', content: '  ' },
        },
      ],
      closure,
    ],
  ])('uses a readable body fallback for %s', (_case, entries, marker) => {
    vi.stubEnv('PI_DASHBOARD_NOTIFY_SETTLED', '1');
    const { service, addNotification } = serviceWithProjectAndThread();
    service.handle(settledChange(entries, marker));
    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Turn completed.' }),
    );
  });

  it.each([
    ['external named session', 'External name', undefined, 'External name'],
    ['title-only session', undefined, 'Session title', 'Session title'],
    ['whitespace-only names', '  ', '\t', 'Pi finished a turn'],
  ])('uses the %s display name when no thread exists', (_case, name, title, expected) => {
    vi.stubEnv('PI_DASHBOARD_NOTIFY_SETTLED', '1');
    const addNotification = vi.fn();
    const service = new NotificationService(
      {
        addNotification,
        orchestration: {
          getSessionThreadLink: () => undefined,
          getProject: () => undefined,
        },
      } as unknown as MetadataStore,
      { notify: vi.fn(async () => undefined) } as unknown as PushSender,
    );
    const change = settledChange([], closure);
    if (change.kind !== 'event') throw new Error('Expected event change');
    change.snapshot.projectId = null;
    change.snapshot.session.name = name;
    change.snapshot.session.title = title;
    service.handle(change);
    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: expected }),
    );
  });

  it('bounds combined project and thread titles to the notification schema', () => {
    vi.stubEnv('PI_DASHBOARD_NOTIFY_SETTLED', '1');
    const { service, addNotification } = serviceWithProjectAndThread(
      'P'.repeat(512),
      'T'.repeat(512),
    );
    service.handle(
      settledChange(
        [
          {
            id: 'assistant-final',
            message: { role: 'assistant', content: 'Answer' },
          },
        ],
        closure,
      ),
    );
    const notification = addNotification.mock.calls[0]?.[0];
    expect(notification).toBeDefined();
    expect(notification?.title).toBe('T'.repeat(512));
    expect(notification?.body).toBe('Answer');
    expect(Value.Check(NotificationEventSchema, notification)).toBe(true);
  });

  it('uses a plain fallback title and bounds long answer text', () => {
    vi.stubEnv('PI_DASHBOARD_NOTIFY_SETTLED', '1');
    const addNotification = vi.fn();
    const service = new NotificationService(
      {
        addNotification,
        orchestration: {
          getSessionThreadLink: () => undefined,
          getProject: () => undefined,
        },
      } as unknown as MetadataStore,
      { notify: vi.fn(async () => undefined) } as unknown as PushSender,
    );
    const change = settledChange(
      [
        {
          id: 'assistant-final',
          message: { role: 'assistant', content: 'x'.repeat(300) },
        },
      ],
      closure,
    );
    if (change.kind !== 'event') throw new Error('Expected event change');
    change.snapshot.projectId = null;
    change.snapshot.session.name = undefined;
    change.snapshot.session.title = undefined;
    service.handle(change);
    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Pi finished a turn',
        body: 'x'.repeat(240),
      }),
    );
  });

  it('does not notify when settled notifications are disabled', () => {
    vi.stubEnv('PI_DASHBOARD_NOTIFY_SETTLED', '0');
    const { service, addNotification, notify } = serviceWithProjectAndThread();
    service.handle(settledChange([], closure));
    expect(addNotification).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
