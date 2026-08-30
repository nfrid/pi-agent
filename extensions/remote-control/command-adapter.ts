import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { DASHBOARD_SUPPORTED_BUILTIN_COMMANDS } from '@pi-dashboard/protocol/dashboard-api';
import type { BridgeImageAttachment } from '@pi-dashboard/protocol/pi-runtime-protocol';
import { requestRuntimePause, resumeRuntimePause } from '../pause/operations';
import { markDashboardFreshUserTurn } from '../shared/runtime/agent-lifecycle';
import { getSessionScopeId } from '../shared/runtime/scoped-services';

type CommandInfo = ReturnType<ExtensionAPI['getCommands']>[number];

// Built-ins are dispatched by Pi's TUI, not AgentSession.prompt(), and are not
// returned by ExtensionAPI.getCommands(). Never let an unsupported one become
// literal model input merely because the bridge has no equivalent operation.
const PI_BUILTIN_COMMANDS = new Set([
  'settings',
  'model',
  'scoped-models',
  'export',
  'import',
  'share',
  'copy',
  'name',
  'session',
  'changelog',
  'hotkeys',
  'fork',
  'clone',
  'tree',
  'trust',
  'login',
  'logout',
  'new',
  'compact',
  'resume',
  'reload',
  'quit',
]);
const DASHBOARD_BUILTIN_COMMANDS = new Set<string>(
  DASHBOARD_SUPPORTED_BUILTIN_COMMANDS.map((command) => command.name),
);

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

function parseArgs(value: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/.test(character)) {
      if (current) args.push(current);
      current = '';
    } else current += character;
  }
  if (current) args.push(current);
  return args;
}

function substituteArgs(content: string, args: readonly string[]): string {
  const all = args.join(' ');
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, target, fallback, sliceStart, sliceLength, simple) => {
      if (target) {
        const value =
          target === '@' || target === 'ARGUMENTS'
            ? all
            : args[Number(target) - 1];
        return value || fallback;
      }
      if (sliceStart) {
        const start = Math.max(0, Number(sliceStart) - 1);
        return args
          .slice(start, sliceLength ? start + Number(sliceLength) : undefined)
          .join(' ');
      }
      if (simple === '@' || simple === 'ARGUMENTS') return all;
      return args[Number(simple) - 1] ?? '';
    },
  );
}

function commandParts(
  text: string,
): { name: string; args: string } | undefined {
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1], args: match[2] ?? '' } : undefined;
}

function skillBlock(command: CommandInfo, skill: string): string {
  const raw = readFileSync(command.sourceInfo.path, 'utf8');
  const body = stripFrontmatter(raw).trim();
  const baseDir =
    command.sourceInfo.baseDir ?? path.dirname(command.sourceInfo.path);
  return `<skill name="${skill}" location="${command.sourceInfo.path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
}

function replaceSkillReferences(
  text: string,
  skills: ReadonlyMap<string, CommandInfo>,
): { text: string; commands: CommandInfo[] } {
  const selected: CommandInfo[] = [];
  const seen = new Set<string>();
  let fenced: '`' | '~' | undefined;
  let inlineTicks = 0;
  const rewritten = text
    .split('\n')
    .map((line) => {
      const fence = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
      if (fence) {
        const marker = fence[0] as '`' | '~';
        if (!fenced) fenced = marker;
        else if (fenced === marker) fenced = undefined;
        return line;
      }
      if (fenced) return line;
      let result = '';
      for (let index = 0; index < line.length; ) {
        if (line[index] === '`') {
          let end = index + 1;
          while (line[end] === '`') end += 1;
          const count = end - index;
          if (inlineTicks === 0) inlineTicks = count;
          else if (inlineTicks === count) inlineTicks = 0;
          result += line.slice(index, end);
          index = end;
          continue;
        }
        if (
          inlineTicks === 0 &&
          line[index] === '$' &&
          line[index - 1] !== '\\'
        ) {
          const candidate = line
            .slice(index + 1)
            .match(/^[a-z0-9]+(?:-[a-z0-9]+)*/u)?.[0];
          const command = candidate ? skills.get(candidate) : undefined;
          if (candidate && command) {
            if (!seen.has(candidate)) {
              seen.add(candidate);
              selected.push(command);
            }
            result += candidate;
            index += candidate.length + 1;
            continue;
          }
        }
        if (
          inlineTicks === 0 &&
          line[index] === '\\' &&
          line[index + 1] === '$'
        ) {
          result += '$';
          index += 2;
          continue;
        }
        result += line[index];
        index += 1;
      }
      return result;
    })
    .join('\n');
  return { text: rewritten, commands: selected };
}

function expandInlineSkills(
  text: string,
  commands: readonly CommandInfo[],
): string {
  const skills = new Map(
    commands.flatMap((command) =>
      command.source === 'skill'
        ? [[command.name.replace(/^skill:/u, ''), command] as const]
        : [],
    ),
  );
  const expanded = replaceSkillReferences(text, skills);
  if (expanded.commands.length === 0) return expanded.text;
  const blocks = expanded.commands.map((command) =>
    skillBlock(command, command.name.replace(/^skill:/u, '')),
  );
  return `${blocks.join('\n\n')}\n\n${expanded.text}`;
}

export function expandDashboardInput(
  text: string,
  commands: readonly CommandInfo[],
): string {
  const invocation = commandParts(text);
  if (invocation) {
    const command = commands.find((item) => item.name === invocation.name);
    if (command && command.source !== 'extension') {
      if (command.source === 'skill') {
        const skill = invocation.name.startsWith('skill:')
          ? invocation.name.slice(6)
          : invocation.name;
        const block = skillBlock(command, skill);
        return invocation.args.trim()
          ? `${block}\n\n${invocation.args.trim()}`
          : block;
      }
      const raw = readFileSync(command.sourceInfo.path, 'utf8');
      const body = stripFrontmatter(raw).trim();
      return expandInlineSkills(
        substituteArgs(body, parseArgs(invocation.args)),
        commands,
      );
    }
  }
  return expandInlineSkills(text, commands);
}

export async function dispatchDashboardInput(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  text: string,
  deliverAs?: 'steer' | 'followUp',
  images: readonly BridgeImageAttachment[] = [],
): Promise<{ accepted: true; command?: string }> {
  const invocation = commandParts(text);
  if (
    invocation &&
    (invocation.name === 'pause' || invocation.name === 'continue')
  ) {
    if (images.length > 0)
      throw new Error('Images cannot be attached to dashboard commands.');
    if (invocation.name === 'pause') {
      requestRuntimePause(pi, ctx);
      return { accepted: true, command: 'pause' };
    }
    if (!resumeRuntimePause(pi, ctx)) throw new Error('Runtime is not paused.');
    return { accepted: true, command: 'continue' };
  }
  if (invocation && !deliverAs) {
    if (images.length > 0 && DASHBOARD_BUILTIN_COMMANDS.has(invocation.name))
      throw new Error('Images cannot be attached to dashboard commands.');
    if (invocation.name === 'compact') {
      await ctx.compact({
        customInstructions: invocation.args.trim() || undefined,
      });
      return { accepted: true, command: 'compact' };
    }
    if (invocation.name === 'name') {
      if (!invocation.args.trim())
        throw new Error('Usage: /name <session name>');
      pi.setSessionName(invocation.args.trim());
      return { accepted: true, command: 'name' };
    }
    if (invocation.name === 'model') {
      const separator = invocation.args.indexOf('/');
      if (separator < 1) throw new Error('Usage: /model <provider/model>');
      const provider = invocation.args.slice(0, separator);
      const modelId = invocation.args.slice(separator + 1);
      const model = ctx.modelRegistry.find(provider, modelId);
      if (!model) throw new Error('Requested model is not available.');
      if (!(await pi.setModel(model)))
        throw new Error('Model authentication is unavailable.');
      return { accepted: true, command: 'model' };
    }
    if (invocation.name === 'quit') {
      ctx.shutdown();
      return { accepted: true, command: 'quit' };
    }
  }
  const commands = pi.getCommands();
  const known = invocation
    ? commands.find((item) => item.name === invocation.name)
    : undefined;
  if (
    invocation &&
    (known?.source === 'extension' || PI_BUILTIN_COMMANDS.has(invocation.name))
  ) {
    throw new Error(
      `Command "/${invocation.name}" is not available through the dashboard yet.`,
    );
  }
  const expanded = expandDashboardInput(text, commands);
  const content =
    images.length > 0
      ? [
          ...(expanded ? [{ type: 'text' as const, text: expanded }] : []),
          ...images.map((image) => {
            const stat = statSync(image.path);
            if (
              !stat.isFile() ||
              stat.size === 0 ||
              stat.size > 5 * 1024 * 1024
            )
              throw new Error('Invalid temporary image attachment.');
            return {
              type: 'image' as const,
              data: readFileSync(image.path).toString('base64'),
              mimeType: image.mediaType,
            };
          }),
        ]
      : expanded;
  const cancelFreshTurn = deliverAs
    ? undefined
    : markDashboardFreshUserTurn(getSessionScopeId(ctx));
  try {
    pi.sendUserMessage(
      content as Parameters<ExtensionAPI['sendUserMessage']>[0],
      deliverAs ? { deliverAs } : undefined,
    );
  } catch (error) {
    cancelFreshTurn?.();
    throw error;
  }
  return { accepted: true };
}
