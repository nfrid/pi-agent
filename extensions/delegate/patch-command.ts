import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {
  applyIsolationPatch,
  discardIsolation,
  isolationPatchBytes,
  isolationValidationCommand,
  isolationValidationScript,
  listIsolations,
  loadIsolation,
  validateIsolationCommand,
  validateIsolationPatch,
} from './isolation';
import { resolveDelegateSession } from './session';

export function registerDelegatePatchCommand(pi: ExtensionAPI): void {
  pi.registerCommand('delegate-patch', {
    description:
      'List, inspect, preview, validate, manually apply, or discard isolated delegate worktrees and patches',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const identifier = tokens[0];
      const action = tokens[1] ?? 'show';
      const validationArgs = tokens.slice(2);
      const validationScript = validationArgs[0];
      if (identifier === 'list') {
        const records = listIsolations();
        ctx.ui.notify(
          records.length
            ? records
                .map(
                  (item) =>
                    `${item.id}  ${item.status}  ${item.patch?.changedPaths.length ?? 0} path(s)  ${item.repositoryRoot}`,
                )
                .join('\n')
            : 'No retained delegate worktrees.',
          'info',
        );
        return;
      }
      if (!identifier) {
        ctx.ui.notify(
          'Usage: /delegate-patch list | <continuation-token|isolation-id> [show|diff|validate <package-script>|validate-command <executable> [args...]|apply|discard]',
          'error',
        );
        return;
      }
      const session = resolveDelegateSession(identifier);
      const id = session?.isolationId ?? identifier;
      const record = loadIsolation(id);
      if (!record) {
        ctx.ui.notify('Isolated delegate record not found.', 'error');
        return;
      }
      if (action === 'show') {
        const patch = record.patch;
        ctx.ui.notify(
          [
            `Isolation ${record.id}: ${record.status}`,
            `Repository: ${record.repositoryRoot}`,
            `Base: ${record.baseHead}`,
            `Worktree: ${record.worktreePath}`,
            `Scopes: ${record.requestedScopes.join(', ')}`,
            `Dependencies: ${record.dependencyMode}`,
            `Patch: ${patch ? `${patch.changedPaths.length} path(s), ${patch.size} bytes, sha256 ${patch.sha256}` : '(none)'}`,
            ...(patch?.unsafeReason
              ? [`Patch rejection: ${patch.unsafeReason}`]
              : []),
            `Run outcome: ${record.runOutcome ?? 'unknown'}`,
            `Validation: ${record.validation?.status ?? 'not-run'}${record.validation?.script ? ` (${record.validation.script})` : ''}`,
            ...(patch?.changedPaths ?? []).map((name) => `- ${name}`),
          ].join('\n'),
          'info',
        );
        return;
      }
      if (action === 'diff') {
        const bytes = isolationPatchBytes(record);
        if (!bytes) {
          ctx.ui.notify('Exact patch bytes are unavailable.', 'error');
          return;
        }
        const text = bytes.toString('utf8');
        const limit = 16 * 1024;
        ctx.ui.notify(
          `Patch sha256 ${record.patch?.sha256}\n\n${text.length > limit ? `${text.slice(0, limit)}\n\n[Preview truncated; exact patch remains retained.]` : text}`,
          'info',
        );
        return;
      }
      if (
        action !== 'validate' &&
        action !== 'validate-command' &&
        action !== 'apply' &&
        action !== 'discard'
      ) {
        ctx.ui.notify(
          'Action must be show, diff, validate, validate-command, apply, or discard.',
          'error',
        );
        return;
      }
      if (
        (action === 'validate' || action === 'validate-command') &&
        !validationScript
      ) {
        ctx.ui.notify(
          action === 'validate'
            ? 'Validation requires a package script name.'
            : 'Command validation requires an executable and optional arguments.',
          'error',
        );
        return;
      }
      if (!ctx.hasUI) {
        console.error('Patch mutation requires an interactive confirmation.');
        return;
      }
      let validationDefinition:
        | { definition: string; sha256: string }
        | undefined;
      if (action === 'validate' || action === 'validate-command') {
        try {
          validationDefinition =
            action === 'validate'
              ? isolationValidationScript(record.id, validationScript as string)
              : isolationValidationCommand(record.id, validationArgs);
        } catch (error) {
          ctx.ui.notify(
            `Validation script rejected: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
          return;
        }
      }
      const confirmed = await ctx.ui.confirm(
        action === 'validate' || action === 'validate-command'
          ? 'Run controlled isolated validation?'
          : action === 'apply'
            ? 'Apply isolated patch?'
            : 'Discard isolation?',
        action === 'validate' || action === 'validate-command'
          ? `Run ${action === 'validate' ? `package script ${validationScript}` : 'exact command argv'} in the isolated worktree? Exact definition (sha256 ${validationDefinition?.sha256}):\n\n${validationDefinition?.definition}\n\nNetwork is denied, the environment is minimal, and any patch change invalidates validation.`
          : action === 'apply'
            ? `Apply ${record.patch?.changedPaths.length ?? 0} changed path(s) to ${record.repositoryRoot}? The broker will revalidate the clean base, successful run, and validation evidence first.`
            : `Remove retained worktree ${record.id}? Exact artifact/session evidence is retained separately.`,
      );
      if (!confirmed) return;
      try {
        if (action === 'validate' || action === 'validate-command') {
          const validated =
            action === 'validate'
              ? await validateIsolationPatch(
                  record.id,
                  validationScript as string,
                  validationDefinition?.sha256 as string,
                )
              : await validateIsolationCommand(
                  record.id,
                  validationArgs,
                  validationDefinition?.sha256 as string,
                );
          ctx.ui.notify(
            `Validation ${validated.validation?.status ?? 'failed'} for ${validated.id}${validated.validation?.reason ? `: ${validated.validation.reason}` : '.'}`,
            validated.validation?.status === 'passed' ? 'info' : 'error',
          );
        } else if (action === 'apply') {
          const applied = await applyIsolationPatch(record.id);
          ctx.ui.notify(
            `Applied isolated patch ${applied.id}. Use /delegate-patch ${applied.id} discard to remove the retained worktree after review.`,
            'info',
          );
        } else {
          await discardIsolation(record.id);
          ctx.ui.notify(`Discarded isolation ${record.id}.`, 'info');
        }
      } catch (error) {
        ctx.ui.notify(
          `Patch broker rejected ${action}: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });
}
