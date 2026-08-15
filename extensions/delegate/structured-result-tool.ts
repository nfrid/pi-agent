import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  asToolSchema,
  type NormalizedDelegateResultSpec,
  normalizeDelegateResultSpec,
} from './structured-result-schema';

/** Parse only the bounded schema passed to a child process. */
export function parseChildDelegateResultSpec(
  encoded: string | undefined,
): NormalizedDelegateResultSpec | undefined {
  if (!encoded) return undefined;
  try {
    const schema = JSON.parse(encoded) as unknown;
    return normalizeDelegateResultSpec({ schema });
  } catch {
    return undefined;
  }
}

/** The one bounded follow-up allowed for a missing structured result. */
export const STRUCTURED_RESULT_REPAIR_MESSAGE =
  'Your previous response ended without calling delegate_result. Do not repeat the investigation. Use the existing session context to submit the complete result now, making delegate_result your final action.';

/** Register the child-only terminating machine-readable completion channel. */
export function registerChildDelegateResultTool(
  pi: ExtensionAPI,
  spec: NormalizedDelegateResultSpec,
): void {
  let resultCallObserved = false;
  let repairTriggered = false;

  // Mark the call at its start. agent_end follows tool execution in the live
  // child, but observing the start makes the no-repair invariant fail closed if
  // that ordering ever changes.
  pi.on('tool_call', (event) => {
    if (event.toolName === 'delegate_result') resultCallObserved = true;
  });
  pi.on('agent_end', () => {
    if (resultCallObserved || repairTriggered) return;
    // Set this before sending the follow-up: its agent_end must never create a
    // second follow-up, even if the result tool is unavailable or fails.
    repairTriggered = true;
    try {
      pi.sendMessage(
        {
          customType: 'delegate-result-repair',
          content: STRUCTURED_RESULT_REPAIR_MESSAGE,
          display: false,
        },
        { deliverAs: 'followUp', triggerTurn: true },
      );
    } catch {
      // The original agent lifecycle remains authoritative. A failed send is
      // reported by the normal child process lifecycle, without a retry loop.
    }
  });
  pi.registerTool({
    name: 'delegate_result',
    label: 'Delegate result',
    description: 'Submit the complete machine-readable result and terminate.',
    promptSnippet:
      'Return the complete structured delegate result and terminate',
    parameters: asToolSchema(spec.schema),
    async execute(_toolCallId: string, params: unknown) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Structured delegate result recorded.',
          },
        ],
        details: params,
        terminate: true,
      };
    },
  } as never);
}
