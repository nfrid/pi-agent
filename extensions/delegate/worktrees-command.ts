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
 * Inspect and clean up delegate worktrees. Harness-managed writable branches
 * are deliverable; caller-owned paths are only recorded and are never removed.
 * Retired read-only snapshots are resumed or dropped rather than integrated.
 */
export function registerDelegateWorktreesCommand(pi: ExtensionAPI): void {
  pi.registerCommand('delegate-worktrees', {
    description: 'List, inspect, or clean up delegate worktrees and branches',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const identifier = tokens[0] ?? 'list';
      const action = tokens[1] ?? 'show';

      if (identifier === 'list') {
        const entries = await listBranchEntries({ scope: 'all' });
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
        const detail = formatBranchDetail({ record, state });
        ctx.ui.notify(
          record.snapshot
            ? `${detail}\nDrop:     /delegate-worktrees ${id} drop`
            : `${detail}\n\nReview:    delegate_branches review ${id}\nIntegrate: delegate_branches merge ${id}\nDiscard:   /delegate-worktrees ${id} drop`,
          'info',
        );
        return;
      }

      if (action === 'remove' || action === 'drop') {
        const deleteBranch = action === 'drop';
        try {
          await removeWorktree(id, { deleteBranch });
          ctx.ui.notify(
            record.ownership === 'caller'
              ? 'Delegate record released; caller-owned worktree and branch retained.'
              : deleteBranch
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
