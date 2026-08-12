import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, test, vi } from 'vitest';
import pauseExtension from './index';
import { resumeRuntimePause } from './operations';

describe('pause extension', () => {
  test('blocks the next provider request and resumes without model input', async () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: ExtensionContext) => unknown
    >();
    const commands = new Map<
      string,
      { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
    >();
    const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
    const statuses: Array<string | undefined> = [];
    const pi = {
      on(
        event: string,
        handler: (event: unknown, ctx: ExtensionContext) => unknown,
      ) {
        handlers.set(event, handler);
      },
      registerCommand(
        name: string,
        command: {
          handler: (args: string, ctx: ExtensionContext) => Promise<void>;
        },
      ) {
        commands.set(name, command);
      },
      events: {
        on(event: string, handler: (value: unknown) => void) {
          const listeners = eventHandlers.get(event) ?? new Set();
          listeners.add(handler);
          eventHandlers.set(event, listeners);
          return () => listeners.delete(handler);
        },
        emit(event: string, value: unknown) {
          for (const handler of eventHandlers.get(event) ?? []) handler(value);
        },
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      hasUI: true,
      isIdle: () => false,
      ui: {
        notify: vi.fn(),
        setStatus: (_key: string, value: string | undefined) =>
          statuses.push(value),
      },
      sessionManager: { getSessionId: () => 'pause-test' },
    } as unknown as ExtensionContext;

    pauseExtension(pi);
    handlers.get('session_start')?.({}, ctx);
    await commands.get('pause')?.handler('', ctx);
    expect(statuses.at(-1)).toBe('Pausing…');

    let released = false;
    const boundary = Promise.resolve(
      handlers.get('before_provider_request')?.({}, ctx),
    ).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(statuses.at(-1)).toBe('Paused');

    expect(resumeRuntimePause(pi, ctx)).toBeDefined();
    await boundary;
    expect(released).toBe(true);
    expect(statuses.at(-1)).toBeUndefined();
    handlers.get('session_shutdown')?.({}, ctx);
  });
});
