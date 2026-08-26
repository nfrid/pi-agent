import { randomUUID } from 'node:crypto';
import { StringEnum } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { type Static, Type } from 'typebox';
import type {
  WakeCondition,
  WakeCoordinator,
  WakeSnapshot,
} from './wake-coordinator';

const References = Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
  minItems: 1,
  maxItems: 32,
});

const Parameters = Type.Object(
  {
    all: Type.Optional(References),
    any: Type.Optional(References),
    delivery: Type.Optional(
      StringEnum(['safe', 'idle'] as const, {
        description:
          'safe (default) delivers at the next safe model boundary; idle waits until the parent would otherwise become idle.',
      }),
    ),
  },
  {
    additionalProperties: false,
    oneOf: [
      { required: ['all'], not: { required: ['any'] } },
      { required: ['any'], not: { required: ['all'] } },
    ],
  },
);

type GateToolParams = Static<typeof Parameters>;

export const EXPLICIT_GATE_PREFIX = 'gate-';

export function isExplicitGate(wake: Pick<WakeSnapshot, 'id'>): boolean {
  return wake.id.startsWith(EXPLICIT_GATE_PREFIX);
}

function condition(params: GateToolParams): WakeCondition {
  if (params.all) return { all: params.all };
  if (params.any) return { any: params.any };
  throw new Error('Exactly one of all or any is required.');
}

function conditionText(value: WakeCondition): string {
  if ('all' in value) return `all(${value.all.join(', ')})`;
  if ('any' in value) return `any(${value.any.join(', ')})`;
  return `node(${value.node})`;
}

export function registerDelegateGateTool(
  pi: ExtensionAPI,
  getCoordinator: () => WakeCoordinator | undefined,
  options: {
    onCancelled?: (wake: WakeSnapshot) => void;
    onRegistered?: (wake: WakeSnapshot, coordinator: WakeCoordinator) => void;
  } = {},
): void {
  pi.registerTool<typeof Parameters, Record<string, unknown>>({
    name: 'delegate_gate',
    label: 'Delegate Gate',
    description:
      'Temporarily hold selected delegate results until an all or any condition is met. Exactly one gate is active per parent branch; a later call replaces it. delivery defaults to safe.',
    parameters: Parameters,
    async execute(
      _toolCallId,
      params: GateToolParams,
      _signal,
      _onUpdate,
      _ctx: ExtensionContext,
    ) {
      const coordinator = getCoordinator();
      if (!coordinator)
        throw new Error('Delegate gate runtime is unavailable.');
      const requested = condition(params);
      for (const current of coordinator.list().filter(isExplicitGate)) {
        const cancelled = coordinator.cancel(
          current.id,
          'Replaced by a later delegate gate.',
        );
        options.onCancelled?.(cancelled);
      }
      const wake = coordinator.register({
        id: `${EXPLICIT_GATE_PREFIX}${randomUUID()}`,
        condition: requested,
        payload: ['handoff', 'metadata'],
        nonObstructive: params.delivery === 'idle',
      });
      options.onRegistered?.(wake, coordinator);
      return {
        content: [
          {
            type: 'text',
            text: `Delegate gate active: ${conditionText(requested)}; delivery=${params.delivery ?? 'safe'}.`,
          },
        ],
        details: {
          condition: requested,
          references: wake.references,
          delivery: params.delivery ?? 'safe',
          state: wake.state,
        },
      };
    },
    renderCall(args, theme) {
      const mode = args.all ? 'all' : args.any ? 'any' : '';
      const count = args.all?.length ?? args.any?.length ?? 0;
      return new Text(
        `${theme.fg('toolTitle', theme.bold('delegate_gate'))}${mode ? ` ${theme.fg('muted', mode)}` : ''}${count ? ` ${theme.fg('accent', String(count))}` : ''}`,
        0,
        0,
      );
    },
    renderResult(toolResult, { expanded }, theme) {
      const body = toolResult.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n');
      return new Text(
        expanded ? body : theme.fg('muted', truncateToWidth(body, 120, '…')),
        0,
        0,
      );
    },
  });
}
