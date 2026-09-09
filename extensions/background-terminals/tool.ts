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
  'Use this tool for non-interactive commands expected to outlive the current turn, such as servers, watchers, dev processes, and long builds; use ordinary bash for short commands. Each process runs `/bin/bash -c` with no stdin and survives parent Pi session shutdown; use stop explicitly. Output is retained in bounded tails. Completion is delivered automatically. Peek is immediate and never waits. Add one-shot literal output watches with watch, or remove them with unwatch; watches observe future output, notify on match, timeout, or process end, and never kill the process.';

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

function hostWatches(
  watches: readonly {
    contains: string;
    stream?: 'stdout' | 'stderr';
    timeout_seconds?: number;
  }[],
) {
  return watches.map(({ contains, stream, timeout_seconds }) => ({
    contains,
    ...(stream ? { stream } : {}),
    ...(timeout_seconds === undefined
      ? {}
      : { timeoutMs: timeout_seconds * 1000 }),
  }));
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
            params.title === undefined
              ? undefined
              : requireText(params.title, 'title').replace(/\s+/gu, ' ');
          const cwd = validateCwd(ctx.cwd, params.cwd);
          const snapshot = await active.start({
            command,
            title,
            cwd,
            ...(params.watch ? { watch: hostWatches(params.watch) } : {}),
          });
          return {
            content: [
              {
                type: 'text',
                text: `Started ${formatSummary(snapshot)}.\nCompletion and watch outcomes will be delivered automatically; do not poll.`,
              },
            ],
            details: { action: 'start', process: processDetails(snapshot) },
          };
        }
        case 'peek': {
          const id = requireText(params.id, 'id');
          const snapshot = await active.peek(id, signal);
          if (snapshot.status !== 'running') cancelCompletion(id);
          return {
            content: [
              {
                type: 'text',
                text: formatPeek(
                  snapshot,
                  params.tail_lines ?? DEFAULT_TAIL_LINES,
                ),
              },
            ],
            details: { action: 'peek', process: processDetails(snapshot) },
          };
        }
        case 'list': {
          const snapshots = await active.list();
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
          const ids = params.ids.map((id) => id.trim()).filter(Boolean);
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
        case 'watch': {
          const id = requireText(params.id, 'id');
          const snapshot = await active.watch(id, hostWatches(params.watch));
          return {
            content: [
              {
                type: 'text',
                text: `Added watches. ${formatSummary(snapshot)}`,
              },
            ],
            details: { action: 'watch', process: processDetails(snapshot) },
          };
        }
        case 'unwatch': {
          const id = requireText(params.id, 'id');
          const watchIds = params.watch_ids
            .map((watchId) => watchId.trim())
            .filter(Boolean);
          if (watchIds.length === 0) throw new Error('watch_ids is required.');
          const snapshot = await active.unwatch(id, watchIds);
          return {
            content: [
              {
                type: 'text',
                text: `Removed watches. ${formatSummary(snapshot)}`,
              },
            ],
            details: { action: 'unwatch', process: processDetails(snapshot) },
          };
        }
      }
    },
    renderCall: renderBackgroundCall,
    renderResult: renderBackgroundResult,
  });
}
