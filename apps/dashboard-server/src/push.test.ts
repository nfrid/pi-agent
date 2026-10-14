import { describe, expect, it, vi } from 'vitest';
import {
  createPushSender,
  notificationTopic,
  PushForegroundClients,
} from './push.js';

const webPush = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(async (_subscription: unknown) => undefined),
}));
vi.mock('web-push', () => ({ default: webPush }));

describe('push foreground clients', () => {
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

describe('push topics', () => {
  it('uses stable topics no longer than the Web Push 32-byte limit', () => {
    const runtime = `runtime-${'x'.repeat(200)}`;
    const first = notificationTopic('waiting', runtime, 'interaction-1');
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(32);
    expect(first).toBe(notificationTopic('waiting', runtime, 'interaction-2'));
    expect(notificationTopic('failed', runtime, 'failure')).not.toBe(first);
  });
});
