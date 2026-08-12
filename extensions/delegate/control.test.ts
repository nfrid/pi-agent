import {
  appendFileSync,
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
} from './control';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('delegate control inbox', () => {
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
    expect(channel.pause(3).accepted).toBe(true);
    channel.acknowledge('pause', 3);
    expect(channel.resume(3).accepted).toBe(true);
    expect(readFileSync(channel.filePath, 'utf8')).toContain('"kind":"resume"');
    expect(channel.enqueue('feedback', 'after resume').accepted).toBe(true);
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
  });
});
