/**
 * Canary for the shim's assumptions about Pi's internals.
 *
 * The shim patches unpublished component internals, so a `pi update` can break
 * it without any change in this repo. This drives the real installed build:
 * derive `Container` from the class chain, patch, render a live sequence, then
 * uninstall and confirm stock rendering returns.
 *
 * A canary that cannot be found is a canary that did not sing, so not finding
 * the build is itself reported: locally it warns, and anywhere the canary is
 * meant to be load-bearing `PI_CANARY_REQUIRED=1` turns that into a failure.
 * Without it a green run would otherwise imply a check that never happened.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { createActivityGroupRenderer } from './renderer';
import { installToolSequenceShim, type ShimHost } from './shim';

const PACKAGE_ENTRY = '@earendil-works/pi-coding-agent/dist/index.js';

/**
 * Prefer the globally installed CLI — that is the build the TUI runs — and fall
 * back to this repo's pinned copy, which still catches shape drift on upgrade.
 */
function piCandidates(): string[] {
  // An explicit pointer is the whole search: silently canarying some other
  // build than the one asked for is worse than reporting that it is missing.
  if (process.env.PI_DIST) return [process.env.PI_DIST];
  const globalRoots = [
    '/opt/homebrew/lib/node_modules',
    '/usr/local/lib/node_modules',
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules'),
  ];
  return [
    ...globalRoots.map((root) => path.join(root, PACKAGE_ENTRY)),
    path.join(process.cwd(), 'node_modules', PACKAGE_ENTRY),
  ];
}

const candidates = piCandidates();
const installedPi = candidates.find((candidate) => existsSync(candidate));
const REQUIRED = Boolean(process.env.PI_CANARY_REQUIRED);

function message(
  content: AssistantMessage['content'] = [
    { type: 'thinking', thinking: '**Inspecting authentication code**' },
    { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
  ],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'anthropic',
    provider: 'anthropic',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  } as AssistantMessage;
}

const theme = { fg: (_color: string, text: string) => text } as Theme;

describe('installed pi build canary', () => {
  it('has a build to drive', () => {
    if (installedPi) {
      expect(existsSync(installedPi)).toBe(true);
      return;
    }
    const searched = candidates.join('\n  ');
    if (REQUIRED)
      throw new Error(
        `PI_CANARY_REQUIRED is set but no installed Pi build was found. Searched:\n  ${searched}`,
      );
    console.warn(
      `activity-groups: no installed Pi build found, so the shim's assumptions about Pi's internals went unchecked. Searched:\n  ${searched}\nSet PI_DIST to a build, or PI_CANARY_REQUIRED=1 to make this a failure.`,
    );
  });
});

describe.skipIf(!installedPi)('installed pi build', () => {
  it('groups and ungroups the real interactive components', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: probing an unpublished surface
    const pi: any = await import(installedPi as string);
    const { AssistantMessageComponent, ToolExecutionComponent, initTheme } = pi;
    // Tool components style themselves on construction.
    initTheme('dark');
    const Container = Object.getPrototypeOf(
      AssistantMessageComponent.prototype,
    ).constructor;

    expect(Container.name).toBe('Container');
    expect(AssistantMessageComponent.prototype instanceof Container).toBe(true);
    expect(ToolExecutionComponent.prototype instanceof Container).toBe(true);

    const chat = new Container();
    const assistant = new AssistantMessageComponent();
    const tool = new ToolExecutionComponent(
      'read',
      'call-1',
      { path: 'src/auth.ts' },
      {},
      undefined,
      { requestRender() {} },
      process.cwd(),
    );

    // Every internal the shim reads must still exist on the real components.
    for (const field of [
      'toolName',
      'toolCallId',
      'args',
      'isPartial',
      'executionStarted',
      'cwd',
      'ui',
    ])
      expect(Object.hasOwn(tool, field), `tool.${field}`).toBe(true);
    expect(
      Object.hasOwn(assistant, 'lastMessage'),
      'assistant.lastMessage',
    ).toBe(true);

    let busy = true;
    const errors: unknown[] = [];
    const host: ShimHost = {
      assistantComponent: AssistantMessageComponent,
      toolComponent: ToolExecutionComponent,
      container: Container,
      getTheme: () => theme,
      isBusy: () => busy,
      isExpanded: () => false,
      requestRender: () => {},
      onError: (error) => errors.push(error),
    };

    const stop = installToolSequenceShim(createActivityGroupRenderer(), host);
    try {
      chat.addChild(assistant);
      assistant.updateContent(message());
      chat.addChild(tool);
      tool.markExecutionStarted();

      const live = chat.render(80).join('\n');
      expect(live).toContain('Inspecting authentication code');
      expect(live).toContain('Reading src/auth.ts');
      expect(live).toContain('1 call · 1 file');

      tool.updateResult({ content: [{ type: 'text', text: 'ok' }] });
      busy = false;
      const done = chat.render(80).join('\n');
      expect(done).toContain('✓ Inspecting authentication code');
      expect(errors).toEqual([]);
    } finally {
      stop();
    }

    // Stock rendering comes back, and it is the fuller output we collapsed.
    const stock = chat.render(80);
    expect(stock.length).toBeGreaterThan(3);
    expect(stock.join('\n')).not.toContain('Inspected authentication code');
  });

  it('groups a session that was already on screen, and expands it once', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: probing an unpublished surface
    const pi: any = await import(installedPi as string);
    const { AssistantMessageComponent, ToolExecutionComponent, initTheme } = pi;
    initTheme('dark');
    const Container = Object.getPrototypeOf(
      AssistantMessageComponent.prototype,
    ).constructor;

    // A resumed session is rebuilt from disk before extensions load, so the
    // whole transcript is in place before anything is patched.
    const chat = new Container();
    const assistant = new AssistantMessageComponent();
    assistant.updateContent(message());
    const tool = new ToolExecutionComponent(
      'read',
      'call-1',
      { path: 'src/auth.ts' },
      {},
      undefined,
      { requestRender() {} },
      process.cwd(),
    );
    tool.updateResult({ content: [{ type: 'text', text: 'AUTH_FILE_BODY' }] });
    const answer = new AssistantMessageComponent();
    answer.updateContent(
      message([
        { type: 'thinking', thinking: '**Reporting back**' },
        { type: 'text', text: 'The token never expires.' },
      ]),
    );
    for (const child of [assistant, tool, answer]) chat.addChild(child);

    let expanded = false;
    const errors: unknown[] = [];
    const stop = installToolSequenceShim(createActivityGroupRenderer(), {
      assistantComponent: AssistantMessageComponent,
      toolComponent: ToolExecutionComponent,
      container: Container,
      getTheme: () => theme,
      isBusy: () => false,
      isExpanded: () => expanded,
      requestRender: () => {},
      onError: (error) => errors.push(error),
      onWarn: (error) => errors.push(error),
    } satisfies ShimHost);
    try {
      const collapsed = chat.render(80).join('\n');
      expect(collapsed).toContain('✓ Inspecting authentication code');
      // The group hides the work it stands for. The answer is in no group, so
      // Pi renders it as it always has — including its thinking, which the
      // group summary never claimed to account for.
      expect(collapsed).toContain('The token never expires.');
      expect(collapsed).not.toContain('AUTH_FILE_BODY');

      expanded = true;
      // Pi drives its own expansion state the same way, per chat child.
      for (const child of chat.children)
        (child as { setExpanded?: (value: boolean) => void }).setExpanded?.(
          true,
        );
      const open = chat.render(80).join('\n');
      // Expanding reveals the calls the group was standing in for …
      expect(open).toContain('AUTH_FILE_BODY');
      // … and never prints the answer a second time.
      expect(open.split('The token never expires.').length - 1).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      stop();
    }
  });
});
