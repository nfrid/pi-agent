import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  NATIVE_ENDPOINT,
  NATIVE_ORIGIN,
  NativeNotifications,
  nativeClickPath,
} from './native-notifications.js';
import { PushForegroundClients } from './push.js';
import { type DashboardRouteContext, dashboardRoutes } from './routes.js';
import { nativeOriginAllowed } from './trpc.js';

const event = {
  id: 'done',
  kind: 'settled' as const,
  sessionId: 'thread/one',
  title: 'Project · Thread',
  body: 'Plain preview',
  createdAt: 1,
};
const presentation = {
  project: 'Project',
  thread: 'Thread',
  url: '/sessions/thread%2Fone',
};

it('scopes native tRPC to the PWA Origin or its same-origin EventSource Referer', () => {
  expect(nativeOriginAllowed(NATIVE_ORIGIN, undefined)).toBe(true);
  expect(nativeOriginAllowed(undefined, `${NATIVE_ORIGIN}/`)).toBe(true);
  expect(nativeOriginAllowed('https://pi.nfrid.me', `${NATIVE_ORIGIN}/`)).toBe(
    false,
  );
  expect(nativeOriginAllowed(undefined, 'https://pi.nfrid.me/')).toBe(false);
  expect(nativeOriginAllowed(undefined, undefined)).toBe(false);
});

it('accepts only exact local supported click routes', () => {
  expect(nativeClickPath(`${NATIVE_ORIGIN}/sessions/thread%2Fone`)).toBe(
    '/sessions/thread%2Fone',
  );
  expect(nativeClickPath(`${NATIVE_ORIGIN}/runtimes/runtime%2Fone`)).toBe(
    '/runtimes/runtime%2Fone',
  );
  expect(nativeClickPath(`${NATIVE_ORIGIN}/`)).toBe('/');
  expect(nativeClickPath(`${NATIVE_ORIGIN}/runtimes`)).toBeUndefined();
  for (const value of [
    'https://pi.nfrid.me/sessions/a',
    `${NATIVE_ORIGIN}/api/sessions/a`,
    `${NATIVE_ORIGIN}/sessions/%00`,
    `${NATIVE_ORIGIN}/sessions/a?x=1`,
    'http://user@127.0.0.1:4174/sessions/a',
    `${NATIVE_ORIGIN}/sessions/%ZZ`,
  ])
    expect(nativeClickPath(value)).toBeUndefined();
});

it('requires enable, separates names, preserves fault meaning, and suppresses native foreground without a Web subscription until expiry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-native-test-'));
  const socketPath = path.join(directory, 'control.sock');
  let now = 0;
  const foreground = new PushForegroundClients(() => now);
  const native = new NativeNotifications(
    socketPath,
    '/not-installed',
    foreground,
  );
  let socket: Socket | undefined;
  const messages: Record<string, unknown>[] = [];
  let permission = 'authorized';
  try {
    await native.start();
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    socket = connect(socketPath);
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
        messages.push(message);
        if (['authorize', 'status', 'click'].includes(message.type))
          socket?.write(
            `${JSON.stringify({ type: 'status', id: message.id, permission })}\n`,
          );
      }
    });
    native.notify(event, presentation);
    expect(messages).toHaveLength(0);
    permission = 'denied';
    expect((await native.control('enable')).enabled).toBe(false);
    native.notify(event, presentation);
    expect(
      messages.filter((message) => message.type === 'notify'),
    ).toHaveLength(0);
    permission = 'authorized';
    expect((await native.control('enable')).enabled).toBe(true);
    native.notify(event, presentation);
    await vi.waitFor(() =>
      expect(
        messages.filter((message) => message.type === 'notify'),
      ).toHaveLength(1),
    );
    expect(messages.find((message) => message.type === 'notify')).toMatchObject(
      {
        title: 'Project',
        subtitle: 'Thread',
        body: 'Plain preview',
        url: `${NATIVE_ORIGIN}/sessions/thread%2Fone`,
      },
    );
    foreground.update({
      endpoint: NATIVE_ENDPOINT,
      tabId: 'pwa',
      visible: true,
      focused: true,
      sessionId: event.sessionId,
    });
    native.notify(event, presentation);
    native.notify(
      { ...event, kind: 'failed', title: 'Pi runtime failed' },
      presentation,
    );
    await vi.waitFor(() =>
      expect(
        messages.filter((message) => message.type === 'notify'),
      ).toHaveLength(2),
    );
    expect(
      messages.filter((message) => message.type === 'notify')[1]?.body,
    ).toBe('Pi runtime failed\nPlain preview');
    now = 30000;
    native.notify(event, presentation);
    await vi.waitFor(() =>
      expect(
        messages.filter((message) => message.type === 'notify'),
      ).toHaveLength(3),
    );
    socket.write(
      `${JSON.stringify({ type: 'click', url: `${NATIVE_ORIGIN}/sessions/thread%2Fone` })}\n`,
    );
    await vi.waitFor(() =>
      expect(native.click()?.path).toBe('/sessions/thread%2Fone'),
    );
    const click = native.click();
    native.acknowledge('other');
    expect(native.click()).toEqual(click);
    native.acknowledge(click?.id ?? '');
    expect(native.click()).toBeUndefined();
    await expect(
      native.control('click', 'https://pi.nfrid.me/sessions/a'),
    ).rejects.toThrow('Invalid native click URL');
    socket.write(
      `${JSON.stringify({ type: 'click', url: `${NATIVE_ORIGIN}/runtimes/runtime%2Fone` })}\n`,
    );
    await vi.waitFor(() =>
      expect(native.click()?.path).toBe('/runtimes/runtime%2Fone'),
    );
    const date = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60000);
    try {
      expect(native.click()).toBeUndefined();
    } finally {
      date.mockRestore();
    }
    socket.destroy();
    await vi.waitFor(() => expect(native.isEnabled()).toBe(false));
  } finally {
    socket?.destroy();
    native.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('restores one persisted activation preference after API restart without a PWA and only with authorized OS permission', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-native-restart-'));
  const socketPath = path.join(directory, 'control.sock');
  const preferencePath = path.join(directory, 'enabled');
  let native: NativeNotifications | undefined;
  let socket: Socket | undefined;
  const commands: string[] = [];
  const start = async (permission: string) => {
    native = new NativeNotifications(
      socketPath,
      '/not-installed',
      new PushForegroundClients(),
    );
    const starting = native.start();
    await vi.waitFor(async () =>
      expect((await stat(socketPath)).isSocket()).toBe(true),
    );
    socket = connect(socketPath);
    const connected = once(socket, 'connect');
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (true) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        commands.push(message.type);
        socket?.write(
          `${JSON.stringify({ type: 'status', id: message.id, permission })}\n`,
        );
      }
    });
    await connected;
    await starting;
  };
  const stop = async () => {
    socket?.destroy();
    native?.close();
    await vi.waitFor(async () =>
      expect(await stat(socketPath).catch(() => undefined)).toBeUndefined(),
    );
  };
  try {
    await start('authorized');
    expect(native?.isEnabled()).toBe(false);
    await native?.control('enable');
    expect(await readFile(preferencePath, 'utf8')).toBe('true\n');
    expect((await stat(preferencePath)).mode & 0o777).toBe(0o600);
    await stop();
    commands.length = 0;
    await start('authorized');
    expect(native?.isEnabled()).toBe(true);
    expect(commands).toEqual(['status']);
    await stop();
    commands.length = 0;
    await start('denied');
    expect(native?.isEnabled()).toBe(false);
    expect(commands).toEqual(['status']);
    expect(await readFile(preferencePath, 'utf8')).toBe('true\n');
  } finally {
    socket?.destroy();
    native?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('allows a human-length authorization wait and cancels activation without acting on a late grant', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-native-authorize-'));
  const socketPath = path.join(directory, 'control.sock');
  const native = new NativeNotifications(
    socketPath,
    '/not-installed',
    new PushForegroundClients(),
  );
  let socket: Socket | undefined;
  const authorizations: string[] = [];
  try {
    await native.start();
    socket = connect(socketPath);
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
        if (message.type === 'authorize') authorizations.push(message.id);
        else
          socket?.write(
            `${JSON.stringify({ type: 'status', id: message.id, permission: 'authorized' })}\n`,
          );
      }
    });
    vi.useFakeTimers();
    let completed = false;
    const firstMessage = once(socket, 'data');
    const first = native.control('enable').then((status) => {
      completed = true;
      return status;
    });
    await firstMessage;
    await vi.advanceTimersByTimeAsync(110000);
    expect(completed).toBe(false);
    socket.write(
      `${JSON.stringify({ type: 'status', id: authorizations[0], permission: 'authorized' })}\n`,
    );
    expect((await first).enabled).toBe(true);
    await native.control('disable');
    const beforeEnable = vi.fn();
    const secondMessage = once(socket, 'data');
    const second = native.control('enable', undefined, beforeEnable);
    await secondMessage;
    await native.control('disable');
    expect((await second).enabled).toBe(false);
    socket.write(
      `${JSON.stringify({ type: 'status', id: authorizations[1], permission: 'authorized' })}\n`,
    );
    expect((await native.control('status')).enabled).toBe(false);
    expect(beforeEnable).not.toHaveBeenCalled();
    expect(await readFile(path.join(directory, 'enabled'), 'utf8')).toBe(
      'false\n',
    );
    const thirdMessage = once(socket, 'data');
    const third = native.control('enable', undefined, beforeEnable);
    await thirdMessage;
    await vi.advanceTimersByTimeAsync(120000);
    expect((await third).enabled).toBe(false);
    socket.write(
      `${JSON.stringify({ type: 'status', id: authorizations[2], permission: 'authorized' })}\n`,
    );
    expect((await native.control('status')).enabled).toBe(false);
    expect(beforeEnable).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    socket?.destroy();
    native.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe('native activation persistence ordering', () => {
  async function connectedAdapter(
    directory: string,
    writer?: (directory: string, value: boolean) => Promise<void>,
  ) {
    const socketPath = path.join(directory, 'control.sock');
    const native = new NativeNotifications(
      socketPath,
      '/not-installed',
      new PushForegroundClients(),
      writer,
    );
    await native.start();
    const socket = connect(socketPath);
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
        if (message.type === 'authorize')
          socket.write(
            `${JSON.stringify({ type: 'status', id: message.id, permission: 'authorized' })}\n`,
          );
      }
    });
    return { native, socket };
  }

  it('does not delete the Mac subscription if atomic preference persistence fails', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'pi-native-write-fail-'),
    );
    const beforeEnable = vi.fn();
    const writer = vi.fn(async () => {
      throw new Error('disk full');
    });
    const { native, socket } = await connectedAdapter(directory, writer);
    try {
      await expect(
        native.control('enable', undefined, beforeEnable),
      ).rejects.toThrow('disk full');
      expect(beforeEnable).not.toHaveBeenCalled();
      expect(writer).toHaveBeenCalledWith(directory, true);
      expect(native.isEnabled()).toBe(false);
      expect(
        await readFile(path.join(directory, 'enabled'), 'utf8').catch(() => ''),
      ).toBe('');
    } finally {
      socket.destroy();
      native.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('clears a durable preference and leaves subscription ownership unchanged when handoff fails', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'pi-native-handoff-fail-'),
    );
    const { native, socket } = await connectedAdapter(directory);
    const subscriptions = new Set(['mac', 'phone']);
    try {
      await expect(
        native.control('enable', undefined, () => {
          throw new Error('subscription handoff failed');
        }),
      ).rejects.toThrow('subscription handoff failed');
      expect(native.isEnabled()).toBe(false);
      expect([...subscriptions]).toEqual(['mac', 'phone']);
      expect(await readFile(path.join(directory, 'enabled'), 'utf8')).toBe(
        'false\n',
      );
    } finally {
      socket.destroy();
      native.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rechecks disable after blocked preference persistence before deleting Mac subscription', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'pi-native-write-race-'),
    );
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const writer = vi.fn(async (dir: string, value: boolean) => {
      if (value) {
        started?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      } else
        await writeFile(path.join(dir, 'enabled'), 'false\n', { mode: 0o600 });
    });
    const { native, socket } = await connectedAdapter(directory, writer);
    const subscriptions = new Set(['mac', 'phone']);
    const beforeEnable = vi.fn(() => {
      subscriptions.delete('mac');
      return () => subscriptions.add('mac');
    });
    try {
      const enable = native.control('enable', undefined, beforeEnable);
      await entered;
      const disable = native.control('disable');
      release?.();
      expect((await enable).enabled).toBe(false);
      await disable;
      expect(beforeEnable).not.toHaveBeenCalled();
      expect([...subscriptions]).toEqual(['mac', 'phone']);
      expect(await readFile(path.join(directory, 'enabled'), 'utf8')).toBe(
        'false\n',
      );
    } finally {
      release?.();
      socket.destroy();
      native.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('native authenticated local handshake', () => {
  it('removes only the enabling browser endpoint, preserves phone, and rejects other origins and unauthenticated control', async () => {
    const subscriptions = new Set(['mac', 'phone']);
    const control = vi.fn(
      async (_action: string, _url?: string, beforeEnable?: () => void) => {
        beforeEnable?.();
        return { available: true, enabled: true, permission: 'authorized' };
      },
    );
    const click = vi.fn(() => ({ id: 'click', path: '/' }));
    const native = {
      control,
      click,
      acknowledge() {},
      isEnabled: () => true,
    } as unknown as NativeNotifications;
    const app = Fastify();
    const context = {
      token: 'isolated-token',
      serverId: () => 'test',
      origins: () => [NATIVE_ORIGIN, 'https://pi.nfrid.me'],
      nativeNotifications: () => native,
      removePushSubscription: (endpoint: string) =>
        subscriptions.delete(endpoint),
      snapshot: () => ({
        serverId: 'test',
        revision: 1,
        cursor: 1,
        runtimes: [],
        sessions: [],
        unread: [],
      }),
      usage: async () => ({ usage: null }),
      readDelegateHistory: async () => ({}),
      readDelegateHistoryRun: async () => ({}),
      renameSession: async () => ({}),
      startRuntime: async () => ({}),
      commandRuntime: async () => ({}),
      stopRuntime: async () => {},
      markNotificationRead() {},
      markAllNotificationsRead() {},
      pushSubscribe() {},
      vapidPublicKey: () => null,
    } as unknown as DashboardRouteContext;
    await app.register(dashboardRoutes, { context });
    try {
      const request = (origin: string, token = 'isolated-token') =>
        app.inject({
          method: 'POST',
          url: '/trpc/nativeControl',
          headers: {
            origin,
            'x-dashboard-token': token,
            'x-dashboard-protocol-version': '3',
          },
          payload: { action: 'enable', endpoint: 'mac' },
        });
      expect((await request('https://pi.nfrid.me')).statusCode).toBe(403);
      expect((await request(NATIVE_ORIGIN, 'wrong')).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/trpc/nativeControl',
            headers: {
              origin: NATIVE_ORIGIN,
              'x-dashboard-protocol-version': '3',
            },
            payload: { action: 'status' },
          })
        ).statusCode,
      ).toBe(401);
      expect(control).not.toHaveBeenCalled();
      const mixedBatch = await app.inject({
        method: 'POST',
        url: '/trpc/telemetryReport,nativeControl?batch=1',
        headers: {
          origin: 'https://pi.nfrid.me',
          'x-dashboard-token': 'isolated-token',
          'x-dashboard-protocol-version': '3',
          'content-type': 'application/json',
        },
        payload: {
          0: { json: { code: 'manual-report', version: 'test', note: 'test' } },
          1: { json: { action: 'enable', endpoint: 'mac' } },
        },
      });
      expect(mixedBatch.body).toContain('FORBIDDEN');
      expect(control).not.toHaveBeenCalled();
      const encodedClicks = await app.inject({
        method: 'GET',
        url: '/trpc/native%43licks?input=%7B%22json%22%3A%7B%7D%7D',
        headers: {
          origin: 'https://pi.nfrid.me',
          'x-dashboard-token': 'isolated-token',
          'x-dashboard-protocol-version': '3',
        },
      });
      expect(encodedClicks.statusCode).toBe(200);
      expect(click).not.toHaveBeenCalled();
      expect(control).not.toHaveBeenCalled();
      const encodedControl = await app.inject({
        method: 'POST',
        url: '/trpc/native%43ontrol',
        headers: {
          origin: 'https://pi.nfrid.me',
          'x-dashboard-token': 'isolated-token',
          'x-dashboard-protocol-version': '3',
        },
        payload: { action: 'enable', endpoint: 'mac' },
      });
      expect(encodedControl.statusCode).toBe(403);
      expect(control).not.toHaveBeenCalled();
      const phoneForeground = await app.inject({
        method: 'POST',
        url: '/api/push/foreground',
        headers: {
          origin: 'https://pi.nfrid.me',
          'x-dashboard-token': 'isolated-token',
        },
        payload: {
          endpoint: 'phone',
          tabId: 't',
          visible: true,
          focused: true,
          sessionId: 'a',
        },
      });
      expect(phoneForeground.statusCode).toBe(204);
      const invalidClick = await app.inject({
        method: 'POST',
        url: '/trpc/nativeControl',
        headers: {
          origin: NATIVE_ORIGIN,
          'x-dashboard-token': 'isolated-token',
          'x-dashboard-protocol-version': '3',
        },
        payload: { action: 'click', url: 'https://pi.nfrid.me/sessions/a' },
      });
      expect(invalidClick.statusCode).toBe(400);
      expect(control).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/trpc/native%43licks?input=%7B%22json%22%3A%7B%7D%7D',
            headers: {
              origin: 'https://pi.nfrid.me',
              'x-dashboard-token': 'isolated-token',
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(click).not.toHaveBeenCalled();
      const nativeStatus = await app.inject({
        method: 'POST',
        url: '/trpc/nativeControl',
        headers: {
          origin: NATIVE_ORIGIN,
          'x-dashboard-token': 'isolated-token',
          'x-dashboard-protocol-version': '3',
        },
        payload: { action: 'status' },
      });
      expect(nativeStatus.statusCode).toBe(200);
      expect(control).toHaveBeenLastCalledWith('status', undefined, undefined);
      control.mockResolvedValueOnce({
        available: true,
        enabled: false,
        permission: 'denied',
      });
      expect((await request(NATIVE_ORIGIN)).statusCode).toBe(200);
      expect([...subscriptions]).toEqual(['mac', 'phone']);
      expect((await request(NATIVE_ORIGIN)).statusCode).toBe(200);
      expect([...subscriptions]).toEqual(['phone']);
      const foreground = await app.inject({
        method: 'POST',
        url: '/api/push/foreground',
        headers: {
          origin: 'https://pi.nfrid.me',
          'x-dashboard-token': 'isolated-token',
        },
        payload: {
          endpoint: NATIVE_ENDPOINT,
          tabId: 't',
          visible: true,
          focused: true,
          sessionId: 'a',
        },
      });
      expect(foreground.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
