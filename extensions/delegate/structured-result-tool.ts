import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  asToolSchema,
  type NormalizedDelegateResultSpec,
  normalizeDelegateResultSpec,
  STRUCTURED_RESULT_CAPS,
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

/** Register the child-only terminating machine-readable completion channel. */
export function registerChildDelegateResultTool(
  pi: ExtensionAPI,
  spec: NormalizedDelegateResultSpec,
): void {
  pi.registerTool({
    name: 'delegate_result',
    label: 'Delegate result',
    description: `Return the complete machine-readable result required by the parent. Use as the final action; if an attempt is rejected, correct it and retry (at most ${STRUCTURED_RESULT_CAPS.maxAttempts} attempts). The last valid attempt wins.`,
    promptSnippet:
      'Return the complete structured delegate result and terminate',
    promptGuidelines: [
      `Use delegate_result as the final action for this task. If an attempt is rejected, correct it and retry, up to ${STRUCTURED_RESULT_CAPS.maxAttempts} total attempts; the last valid attempt wins.`,
      'Pass the complete result object, not a prose summary or a partial projection.',
      'Do not put the structured result JSON in an assistant prose message.',
    ],
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
