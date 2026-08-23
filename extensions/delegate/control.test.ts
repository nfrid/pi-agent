import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createDelegateControlChannel,
  MAX_DELEGATE_CONTROL_MESSAGE_BYTES,
  registerDelegateControl,
  subscribeDelegateControlLifecycle,
} from './control';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('delegate control inbox', () => {
  test('derives a stable hosted control path and detaches without unlinking', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'delegate-control-detach-'));
    roots.push(root);
    const sessionPath = path.join(root, 'session.jsonl');
    const processJobId = '123e4567-e89b-42d3-a456-426614174000';
    const first = createDelegateControlChannel(
      sessionPath,
      'owner-session',
      'background',
      processJobId,
    );
    expect(first.filePath).toBe(
      `${path.resolve(sessionPath)}.${processJobId}.control`,
    );
    expect(first.enqueue('feedback', 'keep this inbox').accepted).toBe(true);
    expect(existsSync(first.filePath)).toBe(true);
    first.detach();
    expect(existsSync(first.filePath)).toBe(true);
    const reopened = createDelegateControlChannel(
      sessionPath,
      'owner-session',
      'background',
      processJobId,
    );
    expect(reopened.filePath).toBe(first.filePath);
    reopened.close();
    expect(existsSync(first.filePath)).toBe(false);
  });

  test('rejects a supplied non-UUID hosted control ID instead of using a legacy path', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'delegate-control-invalid-'));
    roots.push(root);
    expect(() =>
      createDelegateControlChannel(
        path.join(root, 'session.jsonl'),
        'owner-session',
        'background',
        'pid-42',
      ),
    ).toThrow('Hosted delegate control path inputs are invalid');
  });

  test('bounds queued feedback and removes the private inbox on close', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'delegate-control-'));
    roots.push(root);
    const channel = createDelegateControlChannel(
      path.join(root, 'session.jsonl'),
    );

    const queued = channel.enqueue(
      'feedback',
      'Check the interface before finishing.',
    );
    expect(queued).toMatchObject({ accepted: true });
    const request = JSON.parse(readFileSync(channel.filePath, 'utf8')) as {
      kind: string;
      message: string;
    };
    expect(request).toMatchObject({
      kind: 'feedback',
      message: 'Check the interface before finishing.',
    });
    expect(
      channel.enqueue(
        'feedback',
        'x'.repeat(MAX_DELEGATE_CONTROL_MESSAGE_BYTES + 1),
      ),
    ).toMatchObject({ accepted: false, reason: 'message-too-large' });

    channel.close();
    expect(() => readFileSync(channel.filePath)).toThrow();
  });

  test('reports a bound status id on lifecycle events and close', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'delegate-control-bind-'));
    roots.push(root);
    const events: unknown[] = [];
    const unsubscribe = subscribeDelegateControlLifecycle((event) =>
      events.push(event),
    );
    const channel = createDelegateControlChannel(
      path.join(root, 'session.jsonl'),
      'owner-session',
    );
    channel.bindStatusId('ds-1');
    channel.close();
    unsubscribe();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'bind',
          participantId: channel.participantId,
          statusId: 'ds-1',
        }),
        expect.objectContaining({
          type: 'close',
          participantId: channel.participantId,
          ownerSessionId: 'owner-session',
          statusId: 'ds-1',
        }),
      ]),
    );
  });

  test('always reserves pause and resume capacity after feedback bounds', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'delegate-control-full-'));
    roots.push(root);
    const channel = createDelegateControlChannel(
      path.join(root, 'session.jsonl'),
    );
    for (let index = 0; index < 32; index++)
      expect(channel.enqueue('feedback', `message ${index}`).accepted).toBe(
        true,
      );
    expect(channel.enqueue('feedback', 'overflow')).toMatchObject({
      accepted: false,
      reason: 'queue-full',
    });
    const pause = channel.pause(3);
    expect(pause.accepted).toBe(true);
    channel.acknowledge(pause.id ?? '', 'pause', 3);
    expect(channel.resume(3).accepted).toBe(true);
    expect(readFileSync(channel.filePath, 'utf8')).toContain('"kind":"resume"');
    channel.close();
  });

  test('resume preserves feedback accepted after pause acknowledgement', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'delegate-control-resume-'));
    roots.push(root);
    const channel = createDelegateControlChannel(
      path.join(root, 'session.jsonl'),
    );
    const pause = channel.pause(4);
    expect(pause.accepted).toBe(true);
    channel.acknowledge(pause.id ?? '', 'pause', 4);
    expect(channel.enqueue('feedback', 'while paused').accepted).toBe(true);
    expect(channel.resume(4).accepted).toBe(true);
    const inbox = readFileSync(channel.filePath, 'utf8');
    expect(inbox).toContain('while paused');
    expect(inbox).toContain('"kind":"resume"');
    channel.close();
  });

  test('releases feedback quota as child acknowledgements arrive', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'delegate-control-quota-'));
    roots.push(root);
    const channel = createDelegateControlChannel(
      path.join(root, 'session.jsonl'),
    );
    const ids: string[] = [];
    for (let index = 0; index < 32; index++) {
      const queued = channel.enqueue('feedback', `message ${index}`);
      expect(queued.accepted).toBe(true);
      ids.push(queued.id ?? '');
    }
    expect(channel.enqueue('feedback', 'overflow').accepted).toBe(false);
    for (const id of ids) channel.acknowledge(id, 'feedback');
    expect(channel.enqueue('feedback', 'after consumption').accepted).toBe(
      true,
    );
    channel.close();
  });

  test('presents a queued checkpoint at a child reasoning boundary and acknowledges it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'delegate-control-child-'));
    roots.push(root);
    const filePath = path.join(root, 'control.jsonl');
    writeFileSync(
      filePath,
      `${JSON.stringify({
        id: 'checkpoint-1',
        kind: 'checkpoint',
        message: 'Stop and report a coherent partial state.',
        createdAt: Date.now(),
      })}\n`,
      'utf8',
    );
    const handlers = new Map<string, () => unknown>();
    const pi = {
      on(event: string, handler: () => unknown) {
        handlers.set(event, handler);
      },
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const output = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    registerDelegateControl(pi, filePath);
    const result = (await handlers.get('before_agent_start')?.()) as {
      message?: { customType: string; content: string; display: boolean };
    };
    expect(result.message).toMatchObject({
      customType: 'delegate-control',
      content: expect.stringContaining('coherent partial state'),
      display: false,
    });
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('checkpoint-1'),
    );
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  test('child session shutdown removes a detached control file idempotently', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'delegate-control-shutdown-'));
    roots.push(root);
    const filePath = path.join(root, 'control.jsonl');
    writeFileSync(filePath, 'retained while child is live\n', 'utf8');
    const handlers = new Map<string, () => unknown>();
    const pi = {
      on(event: string, handler: () => unknown) {
        handlers.set(event, handler);
      },
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    registerDelegateControl(pi, filePath);
    expect(existsSync(filePath)).toBe(true);
    handlers.get('session_shutdown')?.();
    handlers.get('session_shutdown')?.();
    expect(existsSync(filePath)).toBe(false);
  });

  test('retries accepted feedback after sendMessage throws', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'delegate-control-retry-'));
    roots.push(root);
    const filePath = path.join(root, 'control.jsonl');
    writeFileSync(
      filePath,
      `${JSON.stringify({
        id: 'feedback-retry',
        kind: 'feedback',
        message: 'retry me',
        createdAt: Date.now(),
      })}\n`,
      'utf8',
    );
    const handlers = new Map<string, () => unknown>();
    const sendMessage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('unknown outcome');
      })
      .mockImplementation(() => undefined);
    const pi = {
      on(event: string, handler: () => unknown) {
        handlers.set(event, handler);
      },
      sendMessage,
    } as unknown as ExtensionAPI;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    registerDelegateControl(pi, filePath);
    handlers.get('turn_end')?.();
    handlers.get('turn_end')?.();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[0]).toMatchObject({
      content: expect.stringContaining('retry me'),
    });
  });

  test('acknowledges a pause at the provider boundary and waits for resume', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), 'delegate-pause-child-'));
    roots.push(root);
    const filePath = path.join(root, 'control.jsonl');
    writeFileSync(
      filePath,
      `${JSON.stringify({
        id: 'pause-1',
        kind: 'pause',
        generation: 7,
        createdAt: Date.now(),
      })}\n`,
      'utf8',
    );
    const handlers = new Map<string, () => unknown>();
    const pi = {
      on(event: string, handler: () => unknown) {
        handlers.set(event, handler);
      },
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const output = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    registerDelegateControl(pi, filePath);
    let resumed = false;
    const waiting = Promise.resolve(
      handlers.get('before_provider_request')?.(),
    ).then(() => {
      resumed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resumed).toBe(false);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('"controlKind":"pause"'),
    );
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('"controlGeneration":7'),
    );

    appendFileSync(
      filePath,
      `${JSON.stringify({
        id: 'resume-1',
        kind: 'resume',
        generation: 7,
        createdAt: Date.now(),
      })}\n`,
      'utf8',
    );
    await vi.advanceTimersByTimeAsync(100);
    await waiting;
    expect(resumed).toBe(true);
    const pauseAcks = output.mock.calls.filter(([value]) =>
      String(value).includes('"controlId":"pause-1"'),
    );
    expect(pauseAcks).toHaveLength(1);
  });

  test('acknowledges and gates a pause after persisted tool results at turn end', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), 'delegate-pause-turn-end-'));
    roots.push(root);
    const filePath = path.join(root, 'control.jsonl');
    writeFileSync(
      filePath,
      `${JSON.stringify({
        id: 'pause-turn-end',
        kind: 'pause',
        generation: 11,
        createdAt: Date.now(),
      })}\n`,
      'utf8',
    );
    const handlers = new Map<string, () => unknown>();
    const pi = {
      on(event: string, handler: () => unknown) {
        handlers.set(event, handler);
      },
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const output = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    registerDelegateControl(pi, filePath);
    handlers.get('tool_execution_end')?.();
    let resumed = false;
    const waiting = Promise.resolve(handlers.get('turn_end')?.()).then(() => {
      resumed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resumed).toBe(false);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('"controlId":"pause-turn-end"'),
    );

    appendFileSync(
      filePath,
      `${JSON.stringify({
        id: 'resume-turn-end',
        kind: 'resume',
        generation: 11,
        createdAt: Date.now(),
      })}\n`,
      'utf8',
    );
    await vi.advanceTimersByTimeAsync(100);
    await waiting;
    expect(resumed).toBe(true);
  });

  test('acknowledges pause when resume overtakes it before a provider poll', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'delegate-pause-overtake-'));
    roots.push(root);
    const filePath = path.join(root, 'control.jsonl');
    writeFileSync(
      filePath,
      `${JSON.stringify({
        id: 'pause-overtaken',
        kind: 'pause',
        generation: 8,
        createdAt: Date.now(),
      })}\n${JSON.stringify({
        id: 'resume-overtaking',
        kind: 'resume',
        generation: 8,
        createdAt: Date.now(),
      })}\n`,
      'utf8',
    );
    const handlers = new Map<string, () => unknown>();
    const pi = {
      on(event: string, handler: () => unknown) {
        handlers.set(event, handler);
      },
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const output = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    registerDelegateControl(pi, filePath);
    await handlers.get('before_provider_request')?.();
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('"controlId":"pause-overtaken"'),
    );
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('"controlId":"resume-overtaking"'),
    );
  });

  test('observes resume appended after an acknowledged pause is truncated', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(tmpdir(), 'delegate-pause-compact-'));
    roots.push(root);
    const filePath = path.join(root, 'control.jsonl');
    writeFileSync(
      filePath,
      `${JSON.stringify({
        id: 'pause-compact',
        kind: 'pause',
        generation: 9,
        createdAt: Date.now(),
      })}\n`,
      'utf8',
    );
    const handlers = new Map<string, () => unknown>();
    const pi = {
      on(event: string, handler: () => unknown) {
        handlers.set(event, handler);
      },
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    registerDelegateControl(pi, filePath);
    let resumed = false;
    const waiting = Promise.resolve(
      handlers.get('before_provider_request')?.(),
    ).then(() => {
      resumed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    writeFileSync(filePath, '', 'utf8');
    appendFileSync(
      filePath,
      `${JSON.stringify({
        id: 'resume-after-compact',
        kind: 'resume',
        generation: 9,
        createdAt: Date.now(),
      })}\n`,
      'utf8',
    );
    await vi.advanceTimersByTimeAsync(100);
    await waiting;
    expect(resumed).toBe(true);
  });
});
