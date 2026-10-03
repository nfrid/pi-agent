import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recorded = vi.hoisted(() => vi.fn(() => true));
vi.mock('../shared/telemetry', () => ({ recordHarnessTelemetry: recorded }));

import setup from './index';

type Handler = (event: never, ctx: never) => unknown;
function fixture() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: never) => Promise<void> }
  >();
  const notify = vi.fn();
  const ctx = {
    sessionManager: { getSessionId: () => 'session-1' },
    hasUI: true,
    ui: { notify },
    signal: new AbortController().signal,
  };
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (name: string, command: never) =>
      commands.set(name, command),
  } as unknown as ExtensionAPI;
  setup(pi);
  const emit = (name: string, event: unknown, context: unknown = ctx) =>
    handlers.get(name)?.(event as never, context as never);
  return { commands, ctx, notify, emit };
}
beforeEach(() => recorded.mockReset().mockReturnValue(true));
describe('harness telemetry', () => {
  it('records metadata-only tool outcomes, including nested calls, and separates project command failures', () => {
    const { emit } = fixture();
    emit('tool_execution_start', {
      toolCallId: 'parent/1',
      toolName: 'read',
      args: { secret: 'PRIVATE' },
    });
    emit('tool_execution_end', {
      toolCallId: 'parent/1',
      toolName: 'read',
      isError: true,
      result: { content: 'PRIVATE' },
    });
    expect(recorded).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: 'tool.read',
        code: 'tool-error',
        outcome: 'failure',
        sessionId: 'session-1',
        durationMs: expect.any(Number),
      }),
    );
    expect(JSON.stringify(recorded.mock.calls)).not.toContain('PRIVATE');
    emit('tool_execution_end', {
      toolCallId: '2',
      toolName: 'bash',
      isError: true,
    });
    expect(recorded).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'expected', code: 'command-failed' }),
    );
    emit('tool_execution_end', {
      toolCallId: '3',
      toolName: 'write',
      isError: false,
    });
    expect(recorded).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'success', code: 'completed' }),
    );
  });
  it('records provider errors without message content and treats user aborts as expected', () => {
    const { emit } = fixture();
    emit('message_end', {
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'PRIVATE',
        content: 'PRIVATE',
      },
    });
    expect(recorded).toHaveBeenLastCalledWith({
      operation: 'provider.request',
      code: 'provider-error',
      outcome: 'failure',
      sessionId: 'session-1',
    });
    emit('message_end', {
      message: { role: 'assistant', stopReason: 'aborted' },
    });
    expect(recorded).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'expected' }),
    );
    const count = recorded.mock.calls.length;
    emit('message_end', { message: { role: 'user', content: 'PRIVATE' } });
    expect(recorded).toHaveBeenCalledTimes(count);
  });
  it('saves an explicit note, validates size, and reports storage failure without echoing the note', async () => {
    const { commands, ctx, notify } = fixture();
    const report = commands.get('report-quirk');
    if (!report) throw new Error('Missing report command');
    await report.handler('  Stale widget  ', ctx as never);
    expect(recorded).toHaveBeenLastCalledWith({
      operation: 'manual-report',
      code: 'manual-report',
      outcome: 'quirk',
      note: 'Stale widget',
      sessionId: 'session-1',
    });
    expect(notify).toHaveBeenLastCalledWith(
      expect.stringContaining('recorded locally'),
      'info',
    );
    recorded.mockReturnValue(false);
    await report.handler('private note', ctx as never);
    expect(notify).toHaveBeenLastCalledWith(
      expect.stringContaining('Could not save'),
      'error',
    );
    const count = recorded.mock.calls.length;
    await report.handler('', ctx as never);
    await report.handler('a'.repeat(1_001), ctx as never);
    expect(recorded).toHaveBeenCalledTimes(count);
    expect(JSON.stringify(notify.mock.calls)).not.toContain('private note');
  });
  it('clears tool timing when switching sessions and tolerates stale session context', () => {
    const { emit } = fixture();
    emit('tool_execution_start', { toolCallId: '1', toolName: 'read' });
    emit('session_start', {});
    emit(
      'tool_execution_end',
      { toolCallId: '1', toolName: 'read', isError: false },
      {
        sessionManager: {
          getSessionId: () => {
            throw new Error('stale');
          },
        },
      },
    );
    expect(recorded).toHaveBeenLastCalledWith({
      operation: 'tool.read',
      code: 'completed',
      outcome: 'success',
      sessionId: undefined,
    });
  });
});
