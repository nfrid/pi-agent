import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { formatPeek, formatSummary } from './format';
import type { BackgroundManager } from './manager';
import { renderBackgroundCall, renderBackgroundResult } from './renderers';
import {
  type BackgroundToolDetails,
  DEFAULT_TAIL_LINES,
  Parameters,
  processDetails,
} from './schema';

const DESCRIPTION =
  'Manage long-running, non-interactive Bash commands. Use start for servers, watchers, and long builds; use regular bash for quick commands. Completion is delivered automatically. Actions: start, peek, list, stop.';

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function validateCwd(base: string, requested?: string): string {
  const cwd = resolve(base, requested ?? '.');
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`cwd is not a directory: ${cwd}`);
  }
  return cwd;
}

export function registerBackgroundTool(
  pi: ExtensionAPI,
  getManager: () => BackgroundManager,
): void {
  pi.registerTool<typeof Parameters, BackgroundToolDetails>({
    name: 'background',
    label: 'Background Process',
    description: DESCRIPTION,
    promptSnippet:
      'Start, inspect, and stop long-running non-interactive Bash commands',
    parameters: Parameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const active = getManager();

      switch (params.action) {
        case 'start': {
          const command = requireText(params.command, 'command');
          const title =
            requireText(params.title, 'title')
              .replace(/\s+/g, ' ')
              .slice(0, 80) || 'process';
          const cwd = validateCwd(ctx.cwd, params.cwd);
          const snapshot = active.start({ command, title, cwd });
          return {
            content: [
              {
                type: 'text',
                text: `Started ${snapshot.id} "${snapshot.title}" (pid ${snapshot.pid ?? '?'}). Completion will be delivered automatically; use background peek to inspect output.`,
              },
            ],
            details: { action: 'start', process: processDetails(snapshot) },
          };
        }
        case 'peek': {
          const id = requireText(params.id, 'id');
          const waited = params.wait_seconds ?? 0;
          const snapshot = await active.peek(id, waited * 1000, signal);
          return {
            content: [
              {
                type: 'text',
                text: formatPeek(
                  snapshot,
                  params.tail_lines ?? DEFAULT_TAIL_LINES,
                  waited,
                ),
              },
            ],
            details: { action: 'peek', process: processDetails(snapshot) },
          };
        }
        case 'list': {
          const snapshots = active.list();
          return {
            content: [
              {
                type: 'text',
                text:
                  snapshots.length === 0
                    ? 'No background processes.'
                    : snapshots.map(formatSummary).join('\n'),
              },
            ],
            details: {
              action: 'list',
              processes: snapshots.map(processDetails),
            },
          };
        }
        case 'stop': {
          const ids = params.ids?.map((id) => id.trim()).filter(Boolean) ?? [];
          if (ids.length === 0) throw new Error('ids is required.');
          const snapshots = await active.stop(ids, signal);
          return {
            content: [
              { type: 'text', text: snapshots.map(formatSummary).join('\n') },
            ],
            details: {
              action: 'stop',
              processes: snapshots.map(processDetails),
            },
          };
        }
      }
    },
    renderCall: renderBackgroundCall,
    renderResult: renderBackgroundResult,
  });
}
