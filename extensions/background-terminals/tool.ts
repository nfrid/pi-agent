import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadGuidelines } from '../shared/instructions';
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
  'Use this tool for non-interactive commands expected to outlive the current turn, such as servers, watchers, dev processes, and long builds; use ordinary bash for short commands that should finish within the current turn. Each process runs `/bin/bash -c` with the command as supplied and has no stdin, so it must not require input; quote shell syntax for Bash and set a working directory when needed. Processes belong to the current session and are cleaned up when that session shuts down. Output is retained in bounded tails, so inspect recent output rather than expecting an unbounded log. Completion is delivered automatically. When a process settles, its message resumes the agent turn.';

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
  cancelCompletion: (id: string) => boolean = () => false,
): void {
  pi.registerTool<typeof Parameters, BackgroundToolDetails>({
    name: 'background',
    label: 'Background Process',
    description: DESCRIPTION,
    promptSnippet: 'Run and manage long-running non-interactive Bash commands',
    promptGuidelines: loadGuidelines('instructions.md', __dirname),
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
          if (snapshot.status !== 'running') cancelCompletion(id);
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
          for (const snapshot of snapshots) cancelCompletion(snapshot.id);
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
