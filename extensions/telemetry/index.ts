import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { TELEMETRY_MAX_NOTE_LENGTH } from '@pi-agent/telemetry/contracts';
import { defineExtension } from '../shared/runtime/extension';
import { recordHarnessTelemetry } from '../shared/telemetry';

function sessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

export default defineExtension('telemetry', (pi) => {
  const started = new Map<string, number>();
  pi.on('tool_execution_start', (event) => {
    if (started.size >= 256) {
      const oldest = started.keys().next().value;
      if (oldest !== undefined) started.delete(oldest);
    }
    started.set(event.toolCallId, Date.now());
  });
  pi.on('tool_execution_end', (event, ctx) => {
    const start = started.get(event.toolCallId);
    started.delete(event.toolCallId);
    const expected =
      ctx.signal?.aborted || (event.isError && event.toolName === 'bash');
    recordHarnessTelemetry({
      operation: `tool.${event.toolName}`,
      code: expected
        ? ctx.signal?.aborted
          ? 'cancelled'
          : 'command-failed'
        : event.isError
          ? 'tool-error'
          : 'completed',
      outcome: expected ? 'expected' : event.isError ? 'failure' : 'success',
      sessionId: sessionId(ctx),
      ...(start === undefined ? {} : { durationMs: Date.now() - start }),
    });
  });
  pi.on('message_end', (event, ctx) => {
    if (event.message.role !== 'assistant') return;
    const reason = event.message.stopReason;
    recordHarnessTelemetry({
      operation: 'provider.request',
      code:
        reason === 'error'
          ? 'provider-error'
          : reason === 'aborted'
            ? 'cancelled'
            : reason === 'length'
              ? 'response-limit'
              : 'completed',
      outcome:
        reason === 'error'
          ? 'failure'
          : reason === 'aborted' || reason === 'length'
            ? 'expected'
            : 'success',
      sessionId: sessionId(ctx),
    });
  });
  pi.on('session_start', () => started.clear());
  pi.on('session_shutdown', () => started.clear());
  pi.registerCommand('report-quirk', {
    description:
      'Record a local harness quirk. Do not include prompts, output or secrets.',
    handler: async (args, ctx) => {
      const note = args.trim();
      let message: string;
      let level: 'info' | 'warning' | 'error';
      if (!note || note.length > TELEMETRY_MAX_NOTE_LENGTH) {
        message = `Use /report-quirk <description>, up to ${TELEMETRY_MAX_NOTE_LENGTH} characters. Do not include secrets or conversation content.`;
        level = 'warning';
      } else {
        const saved = recordHarnessTelemetry({
          operation: 'manual-report',
          code: 'manual-report',
          outcome: 'quirk',
          note,
          sessionId: sessionId(ctx),
        });
        message = saved
          ? 'Quirk recorded locally. Review it on the dashboard Diagnostics page.'
          : 'Could not save the local quirk report.';
        level = saved ? 'info' : 'error';
      }
      if (ctx.hasUI) ctx.ui.notify(message, level);
      else console.log(message);
    },
  });
});
