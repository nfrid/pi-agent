import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, test, vi } from 'vitest';
import pauseExtension from './index';
import {
  FOREGROUND_DELEGATES_PAUSED_EVENT,
  resumeRuntimePause,
} from './operations';
import { getPauseCoordinator } from './state';

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
    const workingIndicators: unknown[] = [];
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
        setWorkingIndicator: (value?: unknown) => workingIndicators.push(value),
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
    expect(workingIndicators.at(-1)).toEqual({ frames: ['•'] });

    expect(resumeRuntimePause(pi, ctx)).toBeDefined();
    await boundary;
    expect(released).toBe(true);
    expect(statuses.at(-1)).toBeUndefined();
    expect(workingIndicators.at(-1)).toBeUndefined();
    handlers.get('session_shutdown')?.({}, ctx);
  });

  test('blocks at persisted turn end when pause is requested during a tool', async () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: ExtensionContext) => unknown
    >();
    const commands = new Map<
      string,
      { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
    >();
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
      events: { on: vi.fn(() => () => {}), emit: vi.fn() },
    } as unknown as ExtensionAPI;
    const ctx = {
      hasUI: true,
      isIdle: () => false,
      ui: {
        notify: vi.fn(),
        setStatus: (_key: string, value: string | undefined) =>
          statuses.push(value),
        setWorkingIndicator: vi.fn(),
      },
      sessionManager: { getSessionId: () => 'pause-at-turn-end' },
    } as unknown as ExtensionContext;

    pauseExtension(pi);
    handlers.get('session_start')?.({}, ctx);
    await commands.get('pause')?.handler('', ctx);
    expect(statuses.at(-1)).toBe('Pausing…');

    let released = false;
    const boundary = Promise.resolve(handlers.get('turn_end')?.({}, ctx)).then(
      () => {
        released = true;
      },
    );
    await Promise.resolve();
    expect(released).toBe(false);
    expect(statuses.at(-1)).toBe('Paused');

    expect(resumeRuntimePause(pi, ctx)).toBeDefined();
    await boundary;
    expect(released).toBe(true);
    expect(statuses.at(-1)).toBeUndefined();
    handlers.get('session_shutdown')?.({}, ctx);
  });

  test('treats fully paused foreground delegation as a main boundary', async () => {
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
        setWorkingIndicator: vi.fn(),
      },
      sessionManager: { getSessionId: () => 'foreground-boundary' },
    } as unknown as ExtensionContext;

    pauseExtension(pi);
    handlers.get('session_start')?.({}, ctx);
    handlers.get('tool_execution_start')?.(
      { toolCallId: 'delegate-call', toolName: 'delegate' },
      ctx,
    );
    await commands.get('pause')?.handler('', ctx);
    const coordinator = getPauseCoordinator('foreground-boundary');
    const requested = coordinator.snapshot();
    coordinator.enrollDelegates(requested?.generation ?? 0, ['child']);
    coordinator.markDelegateReached(requested?.generation ?? 0, 'child');

    pi.events.emit(FOREGROUND_DELEGATES_PAUSED_EVENT, {
      scopeId: 'foreground-boundary',
      generation: requested?.generation,
    });

    expect(coordinator.snapshot()).toMatchObject({
      phase: 'paused',
      mainReached: true,
      delegateIds: ['child'],
      reachedDelegateIds: ['child'],
    });
    expect(statuses.at(-1)).toBe('Paused (with 1 delegates)');

    resumeRuntimePause(pi, ctx);
    handlers.get('tool_execution_end')?.(
      { toolCallId: 'delegate-call', toolName: 'delegate' },
      ctx,
    );
    handlers.get('session_shutdown')?.({}, ctx);
  });

  test('keeps pausing while a non-delegate sibling tool is active', async () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: ExtensionContext) => unknown
    >();
    const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
    const pi = {
      on(
        event: string,
        handler: (event: unknown, ctx: ExtensionContext) => unknown,
      ) {
        handlers.set(event, handler);
      },
      registerCommand: vi.fn(),
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
      hasUI: false,
      isIdle: () => false,
      sessionManager: { getSessionId: () => 'sibling-tool' },
    } as unknown as ExtensionContext;

    pauseExtension(pi);
    handlers.get('session_start')?.({}, ctx);
    handlers.get('tool_execution_start')?.(
      { toolCallId: 'delegate-call', toolName: 'delegate' },
      ctx,
    );
    handlers.get('tool_execution_start')?.(
      { toolCallId: 'bash-call', toolName: 'bash' },
      ctx,
    );
    const coordinator = getPauseCoordinator('sibling-tool');
    const requested = coordinator.request();
    pi.events.emit(FOREGROUND_DELEGATES_PAUSED_EVENT, {
      scopeId: 'sibling-tool',
      generation: requested.generation,
    });
    expect(coordinator.snapshot()?.mainReached).toBe(false);

    handlers.get('tool_execution_end')?.(
      { toolCallId: 'bash-call', toolName: 'bash' },
      ctx,
    );
    expect(coordinator.snapshot()?.mainReached).toBe(true);
    resumeRuntimePause(pi, ctx);
    handlers.get('session_shutdown')?.({}, ctx);
  });

  test('late old-scope tool end cannot clear a replacement tool with a reused id', async () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: ExtensionContext) => unknown
    >();
    const pi = {
      on(
        event: string,
        handler: (event: unknown, ctx: ExtensionContext) => unknown,
      ) {
        handlers.set(event, handler);
      },
      registerCommand: vi.fn(),
      events: { on: vi.fn(() => () => {}), emit: vi.fn() },
    } as unknown as ExtensionAPI;
    const makeContext = (id: string) =>
      ({
        hasUI: false,
        isIdle: () => false,
        sessionManager: { getSessionId: () => id },
      }) as unknown as ExtensionContext;
    const old = makeContext('tool-scope-old');
    const replacement = makeContext('tool-scope-new');

    pauseExtension(pi);
    handlers.get('session_start')?.({}, old);
    handlers.get('session_start')?.({}, replacement);
    handlers.get('tool_execution_start')?.(
      { toolCallId: 'reused', toolName: 'bash' },
      replacement,
    );
    const coordinator = getPauseCoordinator('tool-scope-new');
    coordinator.request();
    handlers.get('tool_execution_end')?.(
      { toolCallId: 'reused', toolName: 'delegate' },
      old,
    );
    expect(coordinator.snapshot()?.mainReached).toBe(false);

    handlers.get('session_shutdown')?.({}, old);
    handlers.get('session_shutdown')?.({}, replacement);
  });

  test('late shutdown from an old scope keeps the current pause UI bound', async () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: ExtensionContext) => unknown
    >();
    const commands = new Map<
      string,
      { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
    >();
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
      events: { on: vi.fn(() => () => {}), emit: vi.fn() },
    } as unknown as ExtensionAPI;
    const makeContext = (id: string, statuses: Array<string | undefined>) =>
      ({
        hasUI: true,
        isIdle: () => true,
        ui: {
          notify: vi.fn(),
          setStatus: (_key: string, value: string | undefined) =>
            statuses.push(value),
        },
        sessionManager: { getSessionId: () => id },
      }) as unknown as ExtensionContext;
    const firstStatuses: Array<string | undefined> = [];
    const secondStatuses: Array<string | undefined> = [];
    const first = makeContext('pause-old', firstStatuses);
    const second = makeContext('pause-current', secondStatuses);

    pauseExtension(pi);
    handlers.get('session_start')?.({}, first);
    handlers.get('session_start')?.({}, second);
    handlers.get('session_shutdown')?.({}, first);
    await commands.get('pause')?.handler('', second);
    expect(secondStatuses.at(-1)).toBe('Paused');
    handlers.get('session_shutdown')?.({}, second);
  });
});
