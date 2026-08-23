import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { formatPeek, formatSummary } from './format';
import type { BackgroundManager } from './manager';

const PEEK_TAIL_LINES = 20;

export function registerBackgroundCommands(
  pi: ExtensionAPI,
  getManager: () => BackgroundManager,
  cancelCompletion: (id: string) => boolean,
  onDialogClosed: () => void,
): void {
  pi.registerCommand('ps', {
    description: 'List and inspect background processes',
    handler: async (_args, ctx) => {
      const snapshots = await getManager().list();
      if (snapshots.length === 0) {
        if (ctx.hasUI) ctx.ui.notify('No background processes.', 'info');
        return;
      }

      if (ctx.mode !== 'tui') {
        if (ctx.hasUI) {
          ctx.ui.notify(snapshots.map(formatSummary).join('\n'), 'info');
        }
        return;
      }

      try {
        const labels = snapshots.map(formatSummary);
        const selected = await ctx.ui.select('Background processes', labels);
        if (!selected) return;
        const snapshot = snapshots[labels.indexOf(selected)];
        if (snapshot) {
          if (snapshot.status !== 'running') cancelCompletion(snapshot.id);
          ctx.ui.notify(formatPeek(snapshot, PEEK_TAIL_LINES), 'info');
        }
      } finally {
        // The select dialog can drop the keyed widget; re-assert it.
        onDialogClosed();
      }
    },
  });
}
