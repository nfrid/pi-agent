import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  type RuntimeSnapshot,
  serializeFrame,
} from '../../packages/dashboard-protocol/src/index';
import { InteractionBroker } from '../ask-user/broker';
import {
  BridgeClient,
  createRemoteControlRuntime,
  dispatchDashboardCommand,
  dispatchDashboardInput,
  expandDashboardInput,
} from './index';

const snapshot: RuntimeSnapshot = {
  runtimeId: 'runtime-test',
  ownership: 'external',
  pid: 1,
  cwd: '/tmp',
  liveState: 'idle',
  session: { id: 'session-test', entries: [] },
  pendingInteractions: [],
};

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1_000;
    const tick = () =>
      predicate()
        ? resolve()
        : Date.now() > deadline
          ? reject(new Error('timed out'))
          : setTimeout(tick, 5);
    tick();
  });
}

describe('dashboard input dispatch', () => {
  it('expands prompt templates with native positional argument semantics', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-prompt-'));
    const file = path.join(directory, 'review.md');
    await writeFile(
      file,
      `---\ndescription: Review code\n---\nReview $1 with \${2:-care}. All: $ARGUMENTS\n`,
    );
    expect(
      expandDashboardInput('/review "src/app.ts"', [
        {
          name: 'review',
          source: 'prompt',
          sourceInfo: {
            path: file,
            source: 'local',
            scope: 'user',
            origin: 'top-level',
            baseDir: directory,
          },
        },
      ]),
    ).toBe('Review src/app.ts with care. All: src/app.ts');
    await rm(directory, { recursive: true, force: true });
  });

  it('expands skills into the native skill block and preserves instructions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-skill-'));
    const file = path.join(directory, 'SKILL.md');
    await writeFile(file, '---\nname: demo\n---\nFollow this skill.\n');
    expect(
      expandDashboardInput('/skill:demo inspect this', [
        {
          name: 'skill:demo',
          source: 'skill',
          sourceInfo: {
            path: file,
            source: 'local',
            scope: 'user',
            origin: 'top-level',
            baseDir: directory,
          },
        },
      ]),
    ).toBe(
      `<skill name="demo" location="${file}">\nReferences are relative to ${directory}.\n\nFollow this skill.\n</skill>\n\ninspect this`,
    );
    await rm(directory, { recursive: true, force: true });
  });

  it('dispatches bridge-native commands and rejects unavailable extension commands', async () => {
    const compact = vi.fn();
    const setSessionName = vi.fn();
    const sendUserMessage = vi.fn();
    const pi = {
      getCommands: () => [
        {
          name: 'custom',
          source: 'extension',
          sourceInfo: {
            path: '/tmp/custom.ts',
            source: 'local',
            scope: 'user',
            origin: 'top-level',
          },
        },
      ],
      setSessionName,
      sendUserMessage,
    } as unknown as ExtensionAPI;
    const context = { compact } as unknown as ExtensionContext;

    await expect(
      dispatchDashboardInput(pi, context, '/compact keep decisions'),
    ).resolves.toMatchObject({ command: 'compact' });
    expect(compact).toHaveBeenCalledWith({
      customInstructions: 'keep decisions',
    });
    await dispatchDashboardInput(pi, context, '/name Dashboard session');
    expect(setSessionName).toHaveBeenCalledWith('Dashboard session');
    await expect(
      dispatchDashboardCommand(pi, context, new InteractionBroker(), {
        id: 'rename-1',
        type: 'setSessionName',
        name: 'Bridge name',
      }),
    ).resolves.toEqual({ accepted: true });
    expect(setSessionName).toHaveBeenLastCalledWith('Bridge name');
    await expect(
      dispatchDashboardInput(pi, context, '/custom value'),
    ).rejects.toThrow('not available through the dashboard yet');
    await expect(
      dispatchDashboardInput(pi, context, '/reload'),
    ).rejects.toThrow('not available through the dashboard yet');
    expect(sendUserMessage).not.toHaveBeenCalled();

    await dispatchDashboardInput(pi, context, 'later', 'followUp');
    expect(sendUserMessage).toHaveBeenCalledWith('later', {
      deliverAs: 'followUp',
    });
  });

  it('accepts an EOF-terminated frontmatter delimiter', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-prompt-eof-'));
    const file = path.join(directory, 'empty.md');
    await writeFile(file, '---\r\ndescription: Empty\r\n---');
    expect(
      expandDashboardInput('/empty', [
        {
          name: 'empty',
          source: 'prompt',
          sourceInfo: {
            path: file,
            source: 'local',
            scope: 'user',
            origin: 'top-level',
            baseDir: directory,
          },
        },
      ]),
    ).toBe('');
    await rm(directory, { recursive: true, force: true });
  });
});

describe('remote-control bridge', () => {
  it('reconnects from a cached snapshot without touching a replaced session context', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-bridge-stale-'));
    const socketPath = path.join(directory, 'bridge.sock');
    const previousSocket = process.env.PI_DASHBOARD_SOCKET;
    process.env.PI_DASHBOARD_SOCKET = socketPath;
    const received: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        for (const line of String(chunk).split('\n').filter(Boolean))
          received.push(JSON.parse(line) as Record<string, unknown>);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    let stale = false;
    const active = <T>(value: T): T => {
      if (stale)
        throw new Error(
          'This extension ctx is stale after session replacement or reload.',
        );
      return value;
    };
    const manager = {
      getBranch: () =>
        active([
          {
            type: 'message',
            message: { role: 'user', content: '  inspect   title  ' },
          },
        ]),
      getSessionId: () => active('session-current'),
      getSessionFile: () => active('/tmp/session.jsonl'),
      getSessionName: () => active('Current session'),
      getCwd: () => active('/tmp/project'),
      getLeafId: () => active(undefined),
    };
    const context = {
      get cwd() {
        return active('/tmp/project');
      },
      get model() {
        return active(undefined);
      },
      get thinkingLevel() {
        return active('off');
      },
      sessionManager: manager,
      getContextUsage: () =>
        active({ tokens: 10, contextWindow: 1_000, percent: 1 }),
      isIdle: () => active(true),
    } as unknown as ExtensionContext;
    const runtime = createRemoteControlRuntime({} as ExtensionAPI);
    expect(runtime).toBeDefined();
    runtime?.setContext(context);
    expect(runtime?.snapshot().session.title).toBe('inspect title');
    const equivalentContext = {
      ...context,
      sessionManager: manager,
    } as unknown as ExtensionContext;
    expect(runtime?.isCurrent(equivalentContext)).toBe(true);
    runtime?.clearContext(equivalentContext);
    stale = true;
    runtime?.client.start();
    await waitFor(() =>
      received.some(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type ===
          'runtime.hello',
      ),
    );
    const hello = received.find(
      (frame) =>
        (frame.event as { type?: string } | undefined)?.type ===
        'runtime.hello',
    );
    expect(hello).toMatchObject({
      event: { snapshot: { session: { id: 'unknown' } } },
    });
    runtime?.client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousSocket === undefined) delete process.env.PI_DASHBOARD_SOCKET;
    else process.env.PI_DASHBOARD_SOCKET = previousSocket;
    await rm(directory, { recursive: true, force: true });
  });

  it('sends a full hello and acknowledges serialized daemon commands', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-bridge-'));
    const socketPath = path.join(directory, 'bridge.sock');
    let connection: net.Socket | undefined;
    const received: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      connection = socket;
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          const frame = JSON.parse(line) as Record<string, unknown>;
          received.push(frame);
          if (frame.kind === 'command') {
            const command = frame.command as { id: string };
            socket.write(
              serializeFrame({
                kind: 'ack',
                id: command.id,
                ok: true,
                result: { accepted: true },
              }),
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = new BridgeClient({
      socketPath,
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      handleCommand: async (command) => ({ type: command.type }),
    });
    client.start();
    await waitFor(() =>
      received.some(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type ===
          'runtime.hello',
      ),
    );
    connection?.write(
      serializeFrame({
        kind: 'command',
        command: { id: 'daemon-1', type: 'abort' },
      }),
    );
    await waitFor(() =>
      received.some((frame) => frame.kind === 'ack' && frame.id === 'daemon-1'),
    );
    expect(
      received.find(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type ===
          'runtime.hello',
      ),
    ).toBeDefined();
    client.stop();
    connection?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('rebuilds reconnect hello interactions from the live broker', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'pi-bridge-reconnect-state-'),
    );
    const socketPath = path.join(directory, 'bridge.sock');
    const broker = new InteractionBroker();
    const helloSnapshots: Array<RuntimeSnapshot> = [];
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          const frame = JSON.parse(line) as {
            event?: { type?: string; snapshot?: RuntimeSnapshot };
          };
          if (frame.event?.type !== 'runtime.hello' || !frame.event.snapshot)
            continue;
          helloSnapshots.push(frame.event.snapshot);
          if (connections === 1) socket.destroy();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const pendingPromise = broker.request(
      {
        type: 'ask_user',
        question: 'Continue?',
        choices: [{ label: 'Yes', value: 'yes' }],
        allowCustom: false,
      },
      () => new Promise<null>(() => undefined),
    );
    const interaction = broker.list()[0];
    if (!interaction) throw new Error('interaction was not created');
    const client = new BridgeClient({
      socketPath,
      runtimeId: 'runtime-test',
      snapshot: () => ({ ...snapshot, pendingInteractions: [interaction] }),
      broker,
      handleCommand: async () => ({ accepted: true }),
    });
    client.start();
    await waitFor(() => helloSnapshots.length >= 1);
    broker.cancel(interaction.id);
    await expect(pendingPromise).resolves.toBeNull();
    await waitFor(() => helloSnapshots.length >= 2);
    expect(helloSnapshots[1]?.pendingInteractions).toEqual([]);
    client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('skips cyclic and oversized event payloads without closing the bridge', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'pi-bridge-payload-limit-'),
    );
    const socketPath = path.join(directory, 'bridge.sock');
    let connection: net.Socket | undefined;
    const received: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      connection = socket;
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        for (const line of String(chunk).split('\n').filter(Boolean))
          received.push(JSON.parse(line) as Record<string, unknown>);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = new BridgeClient({
      socketPath,
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      handleCommand: async () => ({ accepted: true }),
    });
    client.start();
    await waitFor(() =>
      received.some(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type ===
          'runtime.hello',
      ),
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      client.sendEvent({
        type: 'message.started',
        sessionId: 'session-test',
        message: cyclic,
      }),
    ).toBe(false);
    expect(
      client.sendEvent({
        type: 'tool.finished',
        sessionId: 'session-test',
        tool: 'x'.repeat(600_000),
      }),
    ).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connection?.destroyed).toBe(false);
    expect(
      received.filter(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type !==
          'runtime.hello',
      ),
    ).toHaveLength(0);
    client.stop();
    connection?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('announces broker questions and resolves them through a daemon command', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'pi-bridge-broker-'),
    );
    const socketPath = path.join(directory, 'bridge.sock');
    const broker = new InteractionBroker();
    let connection: net.Socket | undefined;
    const seen: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      connection = socket;
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          const frame = JSON.parse(line) as Record<string, unknown>;
          seen.push(frame);
          const event = frame.event as
            | { type?: string; interaction?: { id: string } }
            | undefined;
          if (event?.type === 'interaction.requested' && event.interaction)
            socket.write(
              serializeFrame({
                kind: 'command',
                command: {
                  id: 'answer-1',
                  type: 'interaction.answer',
                  interactionId: event.interaction.id,
                  answer: 'yes',
                },
              }),
            );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = new BridgeClient({
      socketPath,
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      broker,
      handleCommand: async (command) => {
        if (command.type === 'interaction.answer')
          broker.answer(command.interactionId, command.answer);
        return { accepted: true };
      },
    });
    client.start();
    await waitFor(() => Boolean(connection));
    const pending = broker.request(
      {
        type: 'ask_user',
        question: 'Continue?',
        choices: [{ label: 'Yes', value: 'yes' }],
        allowCustom: false,
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return null;
      },
    );
    await expect(pending).resolves.toMatchObject({
      answer: 'yes',
      choiceLabel: 'Yes',
    });
    await waitFor(() =>
      seen.some(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type ===
          'interaction.resolved',
      ),
    );
    client.stop();
    connection?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
});
