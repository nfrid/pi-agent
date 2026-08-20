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
  WakePayloadSelector,
  WakeSnapshot,
} from './wake-coordinator';

const ConditionNode = Type.Object(
  { node: Type.String({ minLength: 1, maxLength: 512 }) },
  { additionalProperties: false },
);
const ConditionAll = Type.Object(
  {
    all: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
      minItems: 1,
      maxItems: 32,
    }),
  },
  { additionalProperties: false },
);
const ConditionAny = Type.Object(
  {
    any: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
      minItems: 1,
      maxItems: 32,
    }),
  },
  { additionalProperties: false },
);

/** Deliberately a closed union: wake barriers have exactly node/all/any forms. */
export const WakeConditionSchema = Type.Union([
  ConditionNode,
  ConditionAll,
  ConditionAny,
]);

const WakePayloadSchema = Type.Union([
  StringEnum(['handoff', 'metadata'] as const),
  Type.Object(
    {
      kind: StringEnum(['handoff', 'metadata'] as const),
      node: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
  ),
]);

const Parameters = Type.Object({
  action: StringEnum(
    [
      'subscribe',
      'register',
      'list',
      'status',
      'cancel',
      'recover',
      'retry',
    ] as const,
    {
      description:
        'Subscribe/register a barrier, list or inspect metadata-only status, cancel a subscription, or explicitly recover/retry delivery.',
    },
  ),
  id: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
      description: 'Stable wake subscription ID',
    }),
  ),
  condition: Type.Optional(WakeConditionSchema),
  payload: Type.Optional(
    Type.Array(WakePayloadSchema, { minItems: 1, maxItems: 8 }),
  ),
  reason: Type.Optional(Type.String({ maxLength: 256 })),
  nonObstructive: Type.Optional(
    Type.Boolean({
      description:
        'Deliver only after the parent would otherwise become idle instead of at the next safe model boundary.',
    }),
  ),
});

type WakeToolParams = Static<typeof Parameters>;

const DESCRIPTION =
  'Subscribe to exact delegate workflow attempts and receive a bounded wake when a node, all nodes, or any node settles. Wakes reach the next safe model boundary by default; nonObstructive waits until the parent would otherwise become idle. Registration returns immediately. list/status expose metadata only; payload evidence is delivered once as delegate-wake-result. Use retry for ready delivery failures and recover for an accepted-but-unentered queued delivery.';

function requireId(id: string | undefined): string {
  const value = id?.trim();
  if (!value) throw new Error('id is required.');
  return value;
}

function snapshotText(wake: WakeSnapshot): string {
  const references = wake.references.join(', ');
  const warning = wake.warnings?.length
    ? `; warnings=${wake.warnings.join(' | ')}`
    : '';
  return `${wake.id} · ${wake.state} · ${conditionText(wake.condition)} · refs=${references || 'none'}${warning}`;
}

function conditionText(condition: WakeCondition): string {
  if ('node' in condition) return `node ${condition.node}`;
  if ('all' in condition) return `all(${condition.all.join(', ')})`;
  return `any(${condition.any.join(', ')})`;
}

function metadata(wake: WakeSnapshot): Record<string, unknown> {
  return {
    id: wake.id,
    ownerSessionId: wake.ownerSessionId,
    ownerEpoch: wake.ownerEpoch,
    deliveryKey: wake.deliveryKey,
    condition: wake.condition,
    references: wake.references,
    payload: wake.payload,
    nonObstructive: wake.nonObstructive,
    state: wake.state,
    createdAt: wake.createdAt,
    ...(wake.readyAt !== undefined ? { readyAt: wake.readyAt } : {}),
    ...(wake.queuedAt !== undefined ? { queuedAt: wake.queuedAt } : {}),
    ...(wake.enteredAt !== undefined ? { enteredAt: wake.enteredAt } : {}),
    ...(wake.cancelledAt !== undefined
      ? { cancelledAt: wake.cancelledAt }
      : {}),
    ...(wake.blockedAt !== undefined ? { blockedAt: wake.blockedAt } : {}),
    ...(wake.warnings ? { warnings: wake.warnings } : {}),
    dispatchAttempts: wake.dispatchAttempts,
    ...(wake.lastDispatchFailure
      ? { lastDispatchFailure: wake.lastDispatchFailure }
      : {}),
    ...(wake.reason ? { reason: wake.reason } : {}),
  };
}

function textResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text }], details };
}

export function registerDelegateWakeTool(
  pi: ExtensionAPI,
  getCoordinator: () => WakeCoordinator | undefined,
  options: { onCancelled?: (wake: WakeSnapshot) => void } = {},
): void {
  pi.registerTool<typeof Parameters, Record<string, unknown>>({
    name: 'delegate_wake',
    label: 'Delegate Wake',
    description: DESCRIPTION,
    parameters: Parameters,
    async execute(
      _toolCallId,
      params: WakeToolParams,
      _signal,
      _onUpdate,
      _ctx: ExtensionContext,
    ) {
      const coordinator = getCoordinator();
      if (!coordinator)
        throw new Error('Delegate wake runtime is unavailable.');
      switch (params.action) {
        case 'subscribe':
        case 'register': {
          if (!params.condition) throw new Error('condition is required.');
          const wake = coordinator.register({
            id: requireId(params.id),
            condition: params.condition as WakeCondition,
            ...(params.payload
              ? { payload: params.payload as WakePayloadSelector[] }
              : {}),
            nonObstructive: params.nonObstructive === true,
          });
          return textResult(
            `Wake registered immediately: ${snapshotText(wake)}`,
            { action: params.action, wake: metadata(wake) },
          );
        }
        case 'list': {
          const wakes = coordinator.list();
          return textResult(
            wakes.length
              ? wakes.map(snapshotText).join('\n')
              : 'No delegate wake subscriptions.',
            { action: 'list', wakes: wakes.map(metadata) },
          );
        }
        case 'status': {
          const wake = coordinator.require(requireId(params.id));
          return textResult(snapshotText(wake), {
            action: 'status',
            wake: metadata(wake),
          });
        }
        case 'cancel': {
          const wake = coordinator.cancel(
            requireId(params.id),
            params.reason ?? 'Wake subscription cancelled.',
          );
          options.onCancelled?.(wake);
          return textResult(`Wake cancelled: ${snapshotText(wake)}`, {
            action: 'cancel',
            wake: metadata(wake),
          });
        }
        case 'recover': {
          const wake = coordinator.recover(requireId(params.id));
          return textResult(`Wake recovery queued: ${snapshotText(wake)}`, {
            action: 'recover',
            wake: metadata(wake),
          });
        }
        case 'retry': {
          const wake = coordinator.retry(requireId(params.id));
          return textResult(`Wake retry queued: ${snapshotText(wake)}`, {
            action: 'retry',
            wake: metadata(wake),
          });
        }
      }
    },
    renderCall(args, theme) {
      const action = args.action ?? '';
      const id = args.id ? ` ${theme.fg('accent', args.id)}` : '';
      return new Text(
        `${theme.fg('toolTitle', theme.bold('delegate_wake'))}${action ? ` ${theme.fg('muted', action)}` : ''}${id}`,
        0,
        0,
      );
    },
    renderResult(toolResult, { expanded }, theme) {
      const body = toolResult.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n');
      if (expanded) return new Text(body, 0, 0);
      const details = toolResult.details;
      const wakes = Array.isArray(details?.wakes)
        ? details.wakes.length
        : details?.wake
          ? 1
          : 0;
      return new Text(
        theme.fg(
          details?.action === 'cancel' ? 'warning' : 'muted',
          truncateToWidth(
            wakes
              ? `${details?.action} · ${wakes} wake${wakes === 1 ? '' : 's'}`
              : body,
            120,
            '…',
          ),
        ),
        0,
        0,
      );
    },
  });
}
