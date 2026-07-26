import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { resolveDelegateSession } from './session';
import { listWorktrees, loadWorktree, removeWorktree } from './worktree';

const USAGE =
  'Usage: /delegate-worktrees [list] | <continuation-token|worktree-id> [show|remove|drop]';

function describe(id: string): string | undefined {
  const session = resolveDelegateSession(id);
  const record = loadWorktree(session?.worktreeId ?? id);
  if (!record) return undefined;
  const changed = record.changedPaths ?? [];
  return [
    `Branch:    ${record.branch}`,
    `Worktree:  ${record.worktreePath}`,
    `Repo:      ${record.repositoryRoot}`,
    `Base:      ${record.baseHead.slice(0, 12)} (${record.base}${record.carriedWip ? ', carried uncommitted work' : ''})`,
    `Status:    ${record.status}`,
    changed.length
      ? `Changed:   ${changed.length} path(s)\n${changed.map((name) => `  - ${name}`).join('\n')}`
      : 'Changed:   nothing committed on this branch',
    record.error ? `Note:      ${record.error}` : undefined,
    '',
    `Integrate: git merge ${record.branch}`,
    `Discard:   /delegate-worktrees ${record.id} drop`,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

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
        const records = listWorktrees();
        ctx.ui.notify(
          records.length
            ? records
                .map(
                  (item) =>
                    `${item.id}  ${item.status.padEnd(8)}  ${item.branch}  ${item.changedPaths?.length ?? 0} path(s)`,
                )
                .join('\n')
            : 'No delegate worktrees.',
          'info',
        );
        return;
      }

      const session = resolveDelegateSession(identifier);
      const id = session?.worktreeId ?? identifier;
      if (!loadWorktree(id)) {
        ctx.ui.notify(`No delegate worktree for ${identifier}.`, 'error');
        return;
      }

      if (action === 'show') {
        const text = describe(identifier);
        if (text) ctx.ui.notify(text, 'info');
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
