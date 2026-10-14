import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: (value: import('node:fs').PathLike) =>
      String(value).endsWith(
        'Pi Dashboard Notifications.app/Contents/MacOS/PiNotifications',
      ) || original.existsSync(value),
  };
});

import {
  createPushSender,
  notificationTopic,
  notificationUrl,
  PushForegroundClients,
} from './push.js';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...original,
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { kill: () => true });
      queueMicrotask(() =>
        child.emit('error', new Error('Test helper unavailable')),
      );
      return child;
    },
  };
});

it('keeps Web home fallback and uses supported native fault/session/runtime routes', () => {
  const event = {
    id: 'fault',
    kind: 'failed' as const,
    title: 'Failure',
    body: 'Detail',
    createdAt: 1,
  };
  expect(notificationUrl(event)).toBe('/');
  expect(notificationUrl(event, 'native')).toBe('/');
  expect(
    notificationUrl({ ...event, runtimeId: 'runtime/one' }, 'native'),
  ).toBe('/runtimes/runtime%2Fone');
  expect(
    notificationUrl(
      { ...event, sessionId: 'thread/one', runtimeId: 'runtime/one' },
      'native',
    ),
  ).toBe('/sessions/thread%2Fone');
});

const webPush = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(async (_subscription: unknown) => undefined),
}));
vi.mock('web-push', () => ({ default: webPush }));

describe('push foreground clients', () => {
  it('transfers the enabling Mac leases to native without extending expiry or changing phone presence', () => {
    let now = 0;
    const clients = new PushForegroundClients(() => now);
    for (const endpoint of ['mac', 'phone'])
      clients.update({
        endpoint,
        tabId: endpoint,
        visible: true,
        focused: true,
        sessionId: endpoint,
      });
    now = 10000;
    clients.transferEndpoint('mac', 'native:installed-pwa');
    const event = {
      id: 'done',
      kind: 'settled' as const,
      title: 'Done',
      body: '',
      createdAt: 0,
      sessionId: 'mac',
    };
    expect(clients.matches('mac', event)).toBe(false);
    expect(clients.matches('native:installed-pwa', event)).toBe(true);
    expect(clients.matches('phone', { ...event, sessionId: 'phone' })).toBe(
      true,
    );
    now = 30000;
    expect(clients.matches('native:installed-pwa', event)).toBe(false);
  });
  it('matches settled events within one subscription across active tabs', () => {
    const clients = new PushForegroundClients(() => 100);
    const report = (endpoint: string, tabId: string, sessionId: string) =>
      clients.update({
        endpoint,
        tabId,
        visible: true,
        focused: true,
        sessionId,
      });
    report('endpoint-a', 'tab-a', 'session-a');
    report('endpoint-a', 'tab-b', 'session-b');
    report('endpoint-b', 'tab-c', 'session-a');
    const event = {
      id: 'settled-1',
      kind: 'settled' as const,
      sessionId: 'session-a',
      title: 'Finished',
      body: 'Done',
      createdAt: 100,
    };
    expect(clients.matches('endpoint-a', event)).toBe(true);
    expect(clients.matches('endpoint-b', event)).toBe(true);
    expect(
      clients.matches('endpoint-a', { ...event, kind: 'runtime-exited' }),
    ).toBe(false);
    expect(
      clients.matches('endpoint-a', { ...event, sessionId: 'unknown' }),
    ).toBe(false);
  });

  it('clears blur and route changes, and lets expired leases fail open', () => {
    let now = 0;
    const clients = new PushForegroundClients(() => now);
    const event = {
      id: 'settled-1',
      kind: 'settled' as const,
      sessionId: 'thread',
      title: 'Finished',
      body: 'Done',
      createdAt: 0,
    };
    clients.update({
      endpoint: 'endpoint',
      tabId: 'tab',
      visible: true,
      focused: true,
      sessionId: 'thread',
    });
    expect(clients.matches('endpoint', event)).toBe(true);
    clients.update({
      endpoint: 'endpoint',
      tabId: 'tab',
      visible: false,
      focused: false,
    });
    expect(clients.matches('endpoint', event)).toBe(false);
    clients.update({
      endpoint: 'endpoint',
      tabId: 'tab',
      visible: true,
      focused: true,
      sessionId: 'thread',
    });
    now = 30_000;
    expect(clients.matches('endpoint', event)).toBe(false);
  });

  it('removes one tab without clearing another tab for the same subscription', () => {
    const clients = new PushForegroundClients(() => 0);
    const report = (tabId: string, sessionId: string) =>
      clients.update({
        endpoint: 'endpoint',
        tabId,
        visible: true,
        focused: true,
        sessionId,
      });
    report('tab-a', 'thread-a');
    report('tab-b', 'thread-b');
    clients.update({
      endpoint: 'endpoint',
      tabId: 'tab-a',
      visible: false,
      focused: false,
    });
    expect(
      clients.matches('endpoint', {
        id: 'settled',
        kind: 'settled',
        sessionId: 'thread-a',
        title: 'Finished',
        body: 'Done',
        createdAt: 0,
      }),
    ).toBe(false);
    expect(
      clients.matches('endpoint', {
        id: 'settled',
        kind: 'settled',
        sessionId: 'thread-b',
        title: 'Finished',
        body: 'Done',
        createdAt: 0,
      }),
    ).toBe(true);
  });
});

describe('push sender foreground filtering', () => {
  it('skips only matching settled delivery to the reported subscription', async () => {
    vi.stubEnv('PI_DASHBOARD_VAPID_PUBLIC_KEY', 'public-key');
    vi.stubEnv('PI_DASHBOARD_VAPID_PRIVATE_KEY', 'private-key');
    webPush.sendNotification.mockClear();
    const subscriptions = [
      { endpoint: 'endpoint-a', subscription: { endpoint: 'endpoint-a' } },
      { endpoint: 'endpoint-b', subscription: { endpoint: 'endpoint-b' } },
    ];
    try {
      const sender = await createPushSender({
        pushSubscriptions: () => subscriptions,
      } as never);
      try {
        sender.reportForeground?.({
          endpoint: 'endpoint-a',
          tabId: 'tab-a',
          visible: true,
          focused: true,
          sessionId: 'session-a',
        });
        const event = {
          id: 'settled-a',
          kind: 'settled' as const,
          sessionId: 'session-a',
          title: 'Finished',
          body: 'Done',
          createdAt: 100,
        };

        await sender.notify(event);
        expect(
          webPush.sendNotification.mock.calls.map(
            ([subscription]) => subscription,
          ),
        ).toEqual([{ endpoint: 'endpoint-b' }]);

        webPush.sendNotification.mockClear();
        await sender.notify({ ...event, sessionId: 'session-other' });
        expect(
          webPush.sendNotification.mock.calls.map(
            ([subscription]) => subscription,
          ),
        ).toEqual([{ endpoint: 'endpoint-a' }, { endpoint: 'endpoint-b' }]);

        webPush.sendNotification.mockClear();
        await sender.notify({ ...event, kind: 'runtime-exited' });
        expect(
          webPush.sendNotification.mock.calls.map(
            ([subscription]) => subscription,
          ),
        ).toEqual([{ endpoint: 'endpoint-a' }, { endpoint: 'endpoint-b' }]);
      } finally {
        sender.close?.();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

it.skipIf(process.platform !== 'darwin')(
  'delivers native and phone independently, without recreating the removed Mac Web subscription',
  async () => {
    vi.stubEnv('PI_DASHBOARD_VAPID_PUBLIC_KEY', 'public-key');
    vi.stubEnv('PI_DASHBOARD_VAPID_PRIVATE_KEY', 'private-key');
    const directory = await mkdtemp(path.join(tmpdir(), 'pi-native-push-'));
    const socketPath = path.join(directory, 'control.sock');
    const subscriptions = [
      { endpoint: 'phone', subscription: { endpoint: 'phone' } },
    ];
    const sender = await createPushSender(
      { pushSubscriptions: () => subscriptions } as never,
      socketPath,
    );
    const socket = connect(socketPath);
    const received: Record<string, unknown>[] = [];
    try {
      await once(socket, 'connect');
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        while (true) {
          const end = buffer.indexOf('\n');
          if (end < 0) break;
          const message = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          received.push(message);
          if (message.type === 'authorize')
            socket.write(
              `${JSON.stringify({ type: 'status', id: message.id, permission: 'authorized' })}\n`,
            );
        }
      });
      await sender.native?.control('enable');
      const event = {
        id: 'done',
        kind: 'settled' as const,
        sessionId: 'thread',
        title: 'Browser title',
        body: 'Plain text',
        createdAt: 1,
      };
      const presentation = {
        project: 'Project',
        thread: 'Thread',
        url: '/sessions/thread',
      };
      webPush.sendNotification.mockClear();
      await sender.notify(event, presentation);
      await vi.waitFor(() =>
        expect(
          received.filter((message) => message.type === 'notify'),
        ).toHaveLength(1),
      );
      expect(
        webPush.sendNotification.mock.calls.map(
          ([subscription]) => subscription,
        ),
      ).toEqual([{ endpoint: 'phone' }]);
      sender.reportForeground?.({
        endpoint: 'native:installed-pwa',
        tabId: 'pwa',
        visible: true,
        focused: true,
        sessionId: 'thread',
      });
      await sender.notify(event, presentation);
      expect(webPush.sendNotification).toHaveBeenCalledTimes(2);
      expect(
        received.filter((message) => message.type === 'notify'),
      ).toHaveLength(1);
      socket.destroy();
      await vi.waitFor(() => expect(sender.native?.isEnabled()).toBe(false));
      await sender.notify(event, presentation);
      expect(webPush.sendNotification).toHaveBeenCalledTimes(3);
      expect(subscriptions.map((value) => value.endpoint)).toEqual(['phone']);
    } finally {
      socket.destroy();
      sender.close?.();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('rolls back only the current Mac subscription if native handoff fails partway through removal', async () => {
  const subscriptions = new Map<
    string,
    {
      endpoint: string;
      subscription: unknown;
      createdAt: number;
      updatedAt: number;
    }
  >([
    [
      'mac',
      {
        endpoint: 'mac',
        subscription: { endpoint: 'mac' },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    [
      'phone',
      {
        endpoint: 'phone',
        subscription: { endpoint: 'phone' },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  ]);
  const metadata = {
    pushSubscriptions: () => [...subscriptions.values()],
    removePushSubscription(endpoint: string) {
      subscriptions.delete(endpoint);
      throw new Error('remove failed');
    },
    savePushSubscription(value: {
      endpoint: string;
      subscription: unknown;
      createdAt: number;
      updatedAt: number;
    }) {
      subscriptions.set(value.endpoint, value);
    },
  };
  const sender = await createPushSender(metadata as never);
  expect(() => sender.replaceWithNative?.('mac')).toThrow('remove failed');
  expect([...subscriptions.keys()]).toEqual(['phone', 'mac']);
  sender.close?.();
});

describe('push topics', () => {
  it('uses stable topics no longer than the Web Push 32-byte limit', () => {
    const runtime = `runtime-${'x'.repeat(200)}`;
    const first = notificationTopic('waiting', runtime, 'interaction-1');
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(32);
    expect(first).toBe(notificationTopic('waiting', runtime, 'interaction-2'));
    expect(notificationTopic('failed', runtime, 'failure')).not.toBe(first);
  });
});
