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
