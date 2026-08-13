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

/** Register the child-only terminating machine-readable completion channel. */
export function registerChildDelegateResultTool(
  pi: ExtensionAPI,
  spec: NormalizedDelegateResultSpec,
): void {
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
