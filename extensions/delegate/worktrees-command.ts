import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {
  formatBranchDetail,
  formatBranchLine,
  listBranchEntries,
  resolveWorktreeRecord,
} from './branches';
import { branchState, removeWorktree } from './worktree';

const USAGE =
  'Usage: /delegate-worktrees [list] | <continuation-token|worktree-id> [show|remove|drop]';

/**
 * Inspect and clean up delegate worktrees. Branches are the deliverable, so
 * `remove` takes only the checkout away; `drop` throws the branch out too.
 */
export function registerDelegateWorktreesCommand(pi: ExtensionAPI): void {
  pi.registerCommand('delegate-worktrees', {
    description: 'List, inspect, or clean up delegate worktrees and branches',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const identifier = tokens[0] ?? 'list';
      const action = tokens[1] ?? 'show';

      if (identifier === 'list') {
        const entries = await listBranchEntries();
        ctx.ui.notify(
          entries.length
            ? entries.map(formatBranchLine).join('\n')
            : 'No delegate worktrees.',
          'info',
        );
        return;
      }

      const record = resolveWorktreeRecord(identifier);
      if (!record) {
        ctx.ui.notify(`No delegate worktree for ${identifier}.`, 'error');
        return;
      }
      const id = record.id;

      if (action === 'show') {
        const state = await branchState(record);
        ctx.ui.notify(
          `${formatBranchDetail({ record, state })}\n\nReview:    delegate_branches review ${id}\nIntegrate: delegate_branches merge ${id}\nDiscard:   /delegate-worktrees ${id} drop`,
          'info',
        );
        return;
      }

      if (action === 'remove' || action === 'drop') {
        const deleteBranch = action === 'drop';
        try {
          await removeWorktree(id, { deleteBranch });
          ctx.ui.notify(
            deleteBranch
              ? 'Worktree and branch removed.'
              : 'Worktree removed; its branch is still there.',
            'info',
          );
        } catch (error) {
          ctx.ui.notify(
            `Could not remove the worktree: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
        }
        return;
      }

      ctx.ui.notify(USAGE, 'error');
    },
  });
}
