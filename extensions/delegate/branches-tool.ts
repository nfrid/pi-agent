import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import {
  type BranchEntry,
  formatBranchDetail,
  formatBranchLine,
  formatReview,
  listBranchEntries,
  resolveWorktreeRecord,
} from './branches';
import {
  branchState,
  mergeBranch,
  removeWorktree,
  reviewBranch,
} from './worktree';

const Parameters = Type.Object({
  action: StringEnum(['list', 'review', 'merge', 'drop'] as const, {
    description:
      'List writable delegate branches and retired read-only snapshots. review and merge apply only to writable branches; snapshots can be continued or dropped. drop deletes the checkout and retained ref.',
  }),
  scope: Type.Optional(
    StringEnum(['session', 'all'] as const, {
      description:
        'For list, session (default) shows records created or touched by this parent Pi session; all shows repository history, including legacy records.',
    }),
  ),
  incremental: Type.Optional(
    Type.Boolean({
      description:
        'For review only, show task commits not represented in the current parent HEAD by patch identity. Omit or set false for the full recorded-range audit view.',
    }),
  ),
  summaryOnly: Type.Optional(
    Type.Boolean({
      description:
        'For review only, omit patch bodies while retaining provenance, state, commits, stat, and bounded changed-path evidence.',
    }),
  ),
  paths: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
      minItems: 1,
      maxItems: 64,
      description:
        'For review only, exact repository-relative paths to include. Paths are passed to Git as literal argv pathspecs; absolute and .. paths are rejected.',
    }),
  ),
  patchBudget: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 60_000,
      description:
        'For review only, maximum patch-body characters. The default is 60,000; summaryOnly cannot be combined with this selector.',
    }),
  ),
  id: Type.Optional(
    Type.String({
      maxLength: 512,
      description:
        'Worktree id or continuation token from the writable run. Required for every action except list.',
    }),
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        'For drop, delete an unmerged branch anyway. Its commits are lost.',
    }),
  ),
});

type BranchesDetails = {
  action: 'list' | 'review' | 'merge' | 'drop';
  listScope?: 'session' | 'all';
  reviewMode?: 'full' | 'incremental';
  summaryOnly?: boolean;
  paths?: string[];
  patchBudget?: number;
  totalChangedPaths?: number;
  matchedChangedPaths?: number;
  omittedChangedPaths?: number;
  omittedPatchChars?: number;
  patchTruncated?: boolean;
  truncated?: boolean;
  entries?: Array<{ id: string; branch: string; state: string }>;
  merged?: boolean;
};

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

export function registerDelegateBranchesTool(pi: ExtensionAPI): void {
  pi.registerTool<typeof Parameters, BranchesDetails>({
    name: 'delegate_branches',
    label: 'Delegate Branches',
    description:
      "Review and integrate the branches writable delegate tasks leave behind. list defaults to this parent session; set scope: all for repository history. review gives you the task's commits and diff measured from its own starting point by default; set incremental: true to show only task patches not represented in current parent HEAD. Use summaryOnly, exact repository-relative paths, or patchBudget for bounded review. merge either lands cleanly or leaves your checkout untouched. Actions: list, review, merge, drop.",
    promptSnippet:
      'Review or merge writable delegate branches; continue or drop retired read-only snapshots',
    promptGuidelines: [
      'After a writable run, review its branch before merging, and run the check the task was given yourself. A branch that merges cleanly can still be wrong.',
      'For a continued branch after integration, use review with incremental: true to inspect only task patches not represented in current HEAD; omit it for the full recorded-range audit. Use summaryOnly or exact paths before requesting a bounded patchBudget; omitted paths are evidence that the view is partial.',
      'Merge sibling branches one at a time, reviewing between them: parallel tasks never collide in their worktrees, but their merges can.',
      'Drop a branch once its work is merged, so list stays a picture of what is still outstanding. A retired read-only snapshot is not mergeable: continue it for the same source or targeted refresh, or drop it when no longer needed.',
    ],
    parameters: Parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reviewSelectorUsed =
        params.incremental === true ||
        params.summaryOnly !== undefined ||
        params.paths !== undefined ||
        params.patchBudget !== undefined;
      if (params.action !== 'review' && reviewSelectorUsed)
        throw new Error(
          'incremental, summaryOnly, paths, and patchBudget are only valid for review.',
        );
      if (params.scope !== undefined && params.action !== 'list')
        throw new Error('scope is only valid for list.');
      if (params.action === 'list') {
        const scope = params.scope ?? 'session';
        const entries = await listBranchEntries({
          scope,
          sessionId: ctx?.sessionManager.getSessionId(),
        });
        return {
          ...text(
            entries.length
              ? entries.map(formatBranchLine).join('\n')
              : 'No delegate branches.',
          ),
          details: {
            action: 'list' as const,
            listScope: scope,
            entries: entries.map(({ record, state }) => ({
              id: record.id,
              branch: record.branch,
              state,
            })),
          },
        };
      }

      const identifier = params.id?.trim();
      if (!identifier) throw new Error(`id is required for ${params.action}.`);
      const record = resolveWorktreeRecord(identifier);
      if (!record)
        throw new Error(
          `No delegate worktree or continuation for ${identifier}.`,
        );

      switch (params.action) {
        case 'review': {
          if (record.snapshot) {
            if (
              params.summaryOnly !== undefined ||
              params.paths !== undefined ||
              params.patchBudget !== undefined ||
              params.incremental === true
            )
              throw new Error(
                'Review selectors are not available for retired read-only snapshots.',
              );
            return {
              ...text(
                formatBranchDetail({
                  record,
                  state: await branchState(record),
                }),
              ),
              details: { action: 'review' as const },
            };
          }
          const review = await reviewBranch(record, {
            mode: params.incremental ? 'incremental' : 'full',
            summaryOnly: params.summaryOnly,
            paths: params.paths,
            patchBudget: params.patchBudget,
          });
          const entry: BranchEntry = { record, state: review.state };
          return {
            ...text(
              `${formatBranchDetail(entry)}\n\n${formatReview(record, review)}`,
            ),
            details: {
              action: 'review' as const,
              reviewMode: review.mode,
              summaryOnly: review.summaryOnly,
              paths: review.pathSelectors,
              patchBudget: review.patchBudget,
              totalChangedPaths: review.pathSummary?.total,
              matchedChangedPaths: review.pathSummary?.matched,
              omittedChangedPaths: review.pathSummary?.omitted,
              omittedPatchChars: review.omittedPatchChars,
              patchTruncated: review.patchTruncated,
              truncated: review.truncated,
            },
          };
        }
        case 'merge': {
          if (record.snapshot)
            throw new Error(
              'A retired read-only snapshot is not integration work and cannot be merged. Continue it or drop it instead.',
            );
          const outcome = await mergeBranch(record);
          const detail = [
            outcome.blockedPaths?.length
              ? outcome.blockedPaths.map((file) => `  - ${file}`).join('\n')
              : undefined,
            outcome.conflicted?.length
              ? `Conflicted:\n${outcome.conflicted.map((file) => `  - ${file}`).join('\n')}`
              : undefined,
          ]
            .filter(Boolean)
            .join('\n');
          const summary = outcome.merged
            ? `Merged ${record.branch} into HEAD as ${outcome.commit?.slice(0, 12)}.`
            : `Did not merge ${record.branch}. ${outcome.reason}`;
          return {
            ...text(detail ? `${summary}\n${detail}` : summary),
            details: { action: 'merge' as const, merged: outcome.merged },
          };
        }
        case 'drop': {
          const state = await branchState(record);
          if (state === 'unmerged' && !params.force && !record.snapshot)
            throw new Error(
              `${record.branch} is not merged; its commits would be lost. Review or merge it first, or pass force true.`,
            );
          await removeWorktree(record.id, { deleteBranch: true });
          return {
            ...text(`Dropped ${record.branch} and its checkout.`),
            details: { action: 'drop' as const },
          };
        }
      }
    },
    renderCall(args, theme) {
      const title =
        theme.fg('toolTitle', theme.bold('delegate_branches')) +
        (args.action ? ` ${theme.fg('muted', args.action)}` : '');
      const selectors = [
        args.scope === 'all' ? 'all history' : '',
        args.incremental ? 'incremental' : '',
        args.summaryOnly ? 'summary' : '',
        args.paths?.length ? `${args.paths.length} paths` : '',
        args.patchBudget ? `${args.patchBudget} chars` : '',
      ]
        .filter(Boolean)
        .join(', ');
      const selector = selectors ? ` ${theme.fg('muted', selectors)}` : '';
      return new Text(
        args.id
          ? `${title}${selector} ${theme.fg('accent', args.id)}`
          : `${title}${selector}`,
        0,
        0,
      );
    },
    renderResult(toolResult, { expanded }, theme) {
      const body = toolResult.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .filter(Boolean)
        .join('\n');
      if (expanded) return new Text(body, 0, 0);
      const details = toolResult.details;
      if (details?.action === 'list') {
        const entries = details.entries ?? [];
        const unmerged = entries.filter(
          (entry) => entry.state === 'unmerged',
        ).length;
        return new Text(
          theme.fg('muted', `• ${entries.length} branches`) +
            theme.fg(
              unmerged > 0 ? 'warning' : 'dim',
              ` · ${unmerged} unmerged`,
            ),
          0,
          0,
        );
      }
      const color =
        details?.action === 'merge' && !details.merged ? 'warning' : 'muted';
      return new Text(
        theme.fg(
          color,
          truncateToWidth(body.replace(/\s+/g, ' ').trim(), 120, '…'),
        ),
        0,
        0,
      );
    },
  });
}
