import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  test('presents a queued checkpoint at a child reasoning boundary and acknowledges it', () => {
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
    const result = handlers.get('before_agent_start')?.() as {
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
});
