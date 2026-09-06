import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const MIDTURN_CONTINUE_CUSTOM_TYPE = 'pi-mid-run-compaction-continue';

/** Pi compacts between tool turns natively; retain cleanup for older sessions. */
export default function midRunCompaction(pi: ExtensionAPI): void {
  pi.on('context', (event) => {
    const messages = event.messages.filter(
      (message) =>
        message.role !== 'custom' ||
        message.customType !== MIDTURN_CONTINUE_CUSTOM_TYPE,
    );
    if (messages.length !== event.messages.length) return { messages };
  });
}
