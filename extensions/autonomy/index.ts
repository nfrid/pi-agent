import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { StringEnum } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  loadAutonomyConfig,
  parseCapabilities,
  parseScope,
  resolveProfile,
} from './config';
import {
  collectWorkflowDiagnostics,
  formatWorkflowDiagnostics,
} from './doctor';
import {
  AUTONOMY_METRICS_ENTRY,
  LEGACY_AUTONOMY_METRICS_ENTRY,
  MetricsCollector,
} from './metrics';
import { generateNavigation } from './navigation';
import {
  canAutoApproveProposal,
  createEnvelope,
  decideToolCall,
  diffEnvelopes,
  formatEnvelope,
  formatEnvelopeDelta,
  isAuthorityExpansion,
  mergeProposal,
  migrateEnvelope,
} from './policy';
import { runReadyTaskScheduler } from './scheduler';
import { registerSandboxShell, scrubStaleSandboxShellState } from './shell';
import {
  type AutonomyMetrics,
  type AutonomyMode,
  type AutonomyProfile,
  type AutonomyProfileName,
  CAPABILITIES,
  type Capability,
  type CapabilityEnvelope,
  type EnvelopeProposal,
  type LegacyAutonomyMetrics,
  type LegacyCapabilityEnvelope,
} from './types';

const ENVELOPE_ENTRY = 'workflow-capability-envelope:v2';
const LEGACY_ENVELOPE_ENTRY = 'workflow-capability-envelope:v1';
const PROPOSABLE_CAPABILITIES = ['inspect', 'edit'] as const;

function gitRoot(cwd: string): string {
  try {
    return realpathSync(
      execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
      }).trim(),
    );
  } catch {
    return realpathSync(cwd);
  }
}

function reconstructEnvelope(
  ctx: ExtensionContext,
  fallback: CapabilityEnvelope,
): CapabilityEnvelope {
  let envelope = fallback;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type !== 'custom' ||
      (entry.customType !== ENVELOPE_ENTRY &&
        entry.customType !== LEGACY_ENVELOPE_ENTRY)
    )
      continue;
    const candidate = entry.data as
      | CapabilityEnvelope
      | LegacyCapabilityEnvelope
      | undefined;
    if (candidate?.version === 1 || candidate?.version === 2)
      envelope = migrateEnvelope(candidate);
  }
  return envelope;
}

function restoreMetrics(
  ctx: ExtensionContext,
): AutonomyMetrics | LegacyAutonomyMetrics | undefined {
  let restored: AutonomyMetrics | LegacyAutonomyMetrics | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type !== 'custom' ||
      (entry.customType !== AUTONOMY_METRICS_ENTRY &&
        entry.customType !== LEGACY_AUTONOMY_METRICS_ENTRY)
    )
      continue;
    const candidate = entry.data as
      | AutonomyMetrics
      | LegacyAutonomyMetrics
      | undefined;
    if (candidate?.version === 1 || candidate?.version === 2)
      restored = candidate;
  }
  return restored;
}

function notify(
  ctx: ExtensionCommandContext,
  text: string,
  level: 'info' | 'error' = 'info',
): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else if (level === 'error') console.error(text);
  else console.log(text);
}

function parseEnvelopeCommand(args: string):
  | {
      capabilities: string;
      scope: string;
      ttlMinutes?: number;
    }
  | undefined {
  const match = /^set\s+(\S+)(?:\s+([^\s]+))?(?:\s+--ttl\s+(\d+))?$/i.exec(
    args.trim(),
  );
  if (!match) return;
  return {
    capabilities: match[1],
    scope: match[2] ?? '.',
    ...(match[3] ? { ttlMinutes: Number(match[3]) } : {}),
  };
}

export async function confirmEnvelopeChange(
  ctx: ExtensionContext,
  current: CapabilityEnvelope,
  proposed: CapabilityEnvelope,
  profile: AutonomyProfile,
  rationale: string,
  options?: {
    mode: 'observe' | 'canary' | 'enforce';
    trustedRoots: string[];
    autoApprove: Capability[];
    onAutoApprove?: (delta: ReturnType<typeof diffEnvelopes>) => void;
    onInteractiveDecision?: (approved: boolean) => void;
  },
): Promise<boolean> {
  const delta = diffEnvelopes(current, proposed);
  const expansion = isAuthorityExpansion(delta);
  const reduction =
    delta.removedCapabilities.length > 0 || delta.narrowedPaths.length > 0;
  if (
    expansion &&
    options?.mode === 'canary' &&
    canAutoApproveProposal(
      current,
      proposed,
      options.trustedRoots,
      options.autoApprove,
    )
  ) {
    options.onAutoApprove?.(delta);
    return true;
  }
  const requiresConfirmation =
    expansion || (reduction && profile.confirmReversibleChoices);
  if (!requiresConfirmation) return true;
  if (!ctx.hasUI) {
    options?.onInteractiveDecision?.(false);
    return false;
  }
  const approved = await ctx.ui.confirm(
    expansion ? 'Expand capability envelope?' : 'Reduce capability envelope?',
    `${formatEnvelopeDelta(delta)}\nRationale: ${rationale}\nDelivery and destructive actions always require their own confirmation.`,
  );
  options?.onInteractiveDecision?.(approved);
  return approved;
}

export default function autonomy(pi: ExtensionAPI): void {
  scrubStaleSandboxShellState();
  const settings = loadAutonomyConfig();
  pi.registerFlag('autonomy-enforce', {
    type: 'boolean',
    default: true,
    description:
      'Capability enforcement kill switch. Use --no-autonomy-enforce for an immediate observe-only session; select behavior with --autonomy-mode.',
  });
  pi.registerFlag('autonomy-mode', {
    type: 'string',
    default: settings.mode,
    description:
      'Autonomy mode: observe, canary (auto-lease trusted inspect/edit), or enforce.',
  });
  pi.registerFlag('autonomy-profile', {
    type: 'string',
    default: settings.profile,
    description: 'Autonomy profile: cautious, standard, or high.',
  });
  pi.registerFlag('autonomy-capabilities', {
    type: 'string',
    default: (settings.capabilities.length
      ? settings.capabilities
      : ['inspect']
    ).join(','),
    description: `Initial independent capabilities: ${CAPABILITIES.join(', ')}.`,
  });
  pi.registerFlag('autonomy-scheduler', {
    type: 'boolean',
    default: false,
    description:
      'Enable the bounded todo scheduler with hard local turn/compute limits and advisory provider output/cost targets.',
  });
  pi.registerFlag('autonomy-scope', {
    type: 'string',
    default: (settings.scope.length ? settings.scope : ['.']).join(','),
    description: 'Comma-separated initial paths inside the current repository.',
  });

  const autonomyMode = (): AutonomyMode => {
    if (pi.getFlag('autonomy-enforce') !== true) return 'observe' as const;
    const value = pi.getFlag('autonomy-mode');
    if (value === 'canary' || value === 'enforce' || value === 'observe')
      return value;
    return 'enforce';
  };
  const trustedRoots = (_cwd: string) => [...new Set(settings.trustedRoots)];
  const confirmationOptions = (cwd: string) => ({
    mode: autonomyMode(),
    trustedRoots: trustedRoots(cwd),
    autoApprove: settings.autoApprove,
    onAutoApprove: (delta: ReturnType<typeof diffEnvelopes>) =>
      metrics.autoLease(delta),
    onInteractiveDecision: (approved: boolean) =>
      metrics.interactiveApproval(approved),
  });

  let envelope: CapabilityEnvelope;
  let announced = false;
  let metrics = new MetricsCollector(Date.now(), undefined, autonomyMode());
  const initialEnvelope = (cwd: string) =>
    createEnvelope({
      repositoryRoot: gitRoot(cwd),
      paths: parseScope(pi.getFlag('autonomy-scope')),
      capabilities: parseCapabilities(pi.getFlag('autonomy-capabilities')),
      source: 'cli',
    });

  registerSandboxShell(
    pi,
    () => {
      if (!envelope)
        throw new Error(
          'Capability envelope is unavailable before session start',
        );
      return envelope;
    },
    (result) => metrics.sandboxShell(result),
  );

  const restore = (_event: unknown, ctx: ExtensionContext) => {
    envelope = reconstructEnvelope(ctx, initialEnvelope(ctx.cwd));
    announced = false;
    metrics = new MetricsCollector(
      Date.now(),
      restoreMetrics(ctx),
      autonomyMode(),
    );
  };
  pi.on('session_start', restore);
  pi.on('session_tree', restore);
  pi.on('session_compact', (_event, ctx) => {
    envelope = reconstructEnvelope(ctx, envelope ?? initialEnvelope(ctx.cwd));
    announced = false;
  });

  pi.on('before_agent_start', (_event, ctx) => {
    if (announced) return;
    if (!envelope) envelope = initialEnvelope(ctx.cwd);
    announced = true;
    const profile = resolveProfile(pi.getFlag('autonomy-profile'));
    return {
      message: {
        customType: ENVELOPE_ENTRY,
        content: `Capability broker mode: ${autonomyMode()}. Profile ${profile.name}. ${formatEnvelope(envelope)}\nUse autonomy_propose for the smallest inspect/edit task lease needed by the current request. In canary mode, leases inside trusted roots are approved automatically; expansions outside the trusted ceiling remain interactive. Use sandbox_shell instead of uncontained Bash. Local-git, delivery, and destructive authority remain separate and are never inferred from shell text.`,
        display: false,
        details: { envelope, profile: profile.name },
      },
    };
  });

  pi.on('turn_start', () => metrics.turn());
  pi.on('tool_call', (event: ToolCallEvent, ctx: ExtensionContext) => {
    metrics.toolCall(event.toolName, event.input);
    if (!envelope) envelope = initialEnvelope(ctx.cwd);
    const decision = decideToolCall(event, envelope, ctx.cwd);
    if (decision.allowed) return;
    if (autonomyMode() === 'observe') {
      metrics.policyDecision(decision.code, false);
      return;
    }
    metrics.policyDecision(decision.code, true);
    return {
      block: true,
      reason: `[${decision.code}] ${decision.reason} Use /autonomy-envelope to inspect or change user-owned scope.`,
    };
  });
  pi.on('tool_result', (event) => metrics.toolResult(event));
  pi.on('agent_settled', () => metrics.persist(pi));

  pi.registerCommand('autonomy-envelope', {
    description:
      'Show or explicitly replace the user-owned capability envelope for this session',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!envelope) envelope = initialEnvelope(ctx.cwd);
      const command = args.trim();
      if (!command || command === 'show') {
        notify(
          ctx,
          `${formatEnvelope(envelope)}\nMode: ${autonomyMode()}\nProfile: ${resolveProfile(pi.getFlag('autonomy-profile')).name}`,
        );
        return;
      }
      if (command === 'clear') {
        const proposed = createEnvelope({
          repositoryRoot: gitRoot(ctx.cwd),
          paths: ['.'],
          capabilities: ['inspect'],
          source: 'user-command',
        });
        if (
          !(await confirmEnvelopeChange(
            ctx,
            envelope,
            proposed,
            resolveProfile(pi.getFlag('autonomy-profile')),
            'Explicit reset to inspect-only authority.',
          ))
        ) {
          notify(ctx, 'Capability envelope change was not confirmed.', 'error');
          return;
        }
        envelope = proposed;
        pi.appendEntry(ENVELOPE_ENTRY, envelope);
        notify(ctx, formatEnvelope(envelope));
        return;
      }
      const parsed = parseEnvelopeCommand(command);
      if (!parsed) {
        notify(
          ctx,
          'Usage: /autonomy-envelope [show|clear|set <cap1,cap2> <path1,path2> [--ttl minutes]]',
          'error',
        );
        return;
      }
      const capabilities = parseCapabilities(parsed.capabilities);
      if (capabilities.length === 0) {
        notify(ctx, 'No valid capabilities supplied.', 'error');
        return;
      }
      const proposed = createEnvelope({
        repositoryRoot: gitRoot(ctx.cwd),
        paths: parseScope(parsed.scope),
        capabilities,
        source: 'user-command',
        ttlMs: parsed.ttlMinutes ? parsed.ttlMinutes * 60_000 : undefined,
      });
      if (
        !(await confirmEnvelopeChange(
          ctx,
          envelope,
          proposed,
          resolveProfile(pi.getFlag('autonomy-profile')),
          'Explicit /autonomy-envelope replacement.',
        ))
      ) {
        notify(ctx, 'Capability envelope change was not confirmed.', 'error');
        return;
      }
      envelope = proposed;
      pi.appendEntry(ENVELOPE_ENTRY, envelope);
      notify(ctx, formatEnvelope(envelope));
    },
  });

  pi.registerTool({
    name: 'autonomy_propose',
    label: 'Propose Capability Envelope',
    description:
      'Request the minimal inspect/edit task lease required by the current user request. Canary mode automatically approves leases inside user-trusted roots; other expansions remain interactive. Local Git, delivery, and destructive authority are never inferred.',
    promptSnippet:
      'Request a minimal repository-aware inspect/edit task lease when the current request requires it',
    parameters: Type.Object({
      capabilities: Type.Array(StringEnum(PROPOSABLE_CAPABILITIES), {
        minItems: 1,
        maxItems: PROPOSABLE_CAPABILITIES.length,
      }),
      scope: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        minItems: 1,
        maxItems: 100,
      }),
      rationale: Type.String({ minLength: 1, maxLength: 200 }),
      ttlMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 * 60 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!envelope) envelope = initialEnvelope(ctx.cwd);
      const proposal: EnvelopeProposal = {
        capabilities: params.capabilities,
        paths: params.scope,
        rationale: params.rationale,
        ...(params.ttlMinutes ? { ttlMs: params.ttlMinutes * 60_000 } : {}),
      };
      const proposed = mergeProposal(envelope, proposal);
      const delta = diffEnvelopes(envelope, proposed);
      if (!isAuthorityExpansion(delta))
        return {
          content: [
            {
              type: 'text' as const,
              text: `No authority expansion is needed.\n${formatEnvelope(envelope)}`,
            },
          ],
          details: { envelope, delta },
        };
      if (
        !(await confirmEnvelopeChange(
          ctx,
          envelope,
          proposed,
          resolveProfile(pi.getFlag('autonomy-profile')),
          proposal.rationale,
          confirmationOptions(ctx.cwd),
        ))
      )
        throw new Error(
          `Capability expansion was not confirmed.\n${formatEnvelopeDelta(delta)}`,
        );
      envelope = proposed;
      pi.appendEntry(ENVELOPE_ENTRY, envelope);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Capability envelope updated.\n${formatEnvelope(envelope)}`,
          },
        ],
        details: { envelope, delta },
      };
    },
  });

  pi.registerTool({
    name: 'repository_navigate',
    label: 'Repository Navigate',
    description:
      'Generate freshness-marked candidate files, bounded symbol/import hints, changed-file neighborhoods, workspace facts, likely tests, package scripts, and exact fixed-string matches. This is advisory: read the relevant live implementation and tests before mutation or product/API decisions.',
    promptSnippet:
      'Generate current-checkout navigation candidates, then verify relevant live code and tests before acting',
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 500,
          description: 'Optional exact text/symbol to locate.',
        }),
      ),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await generateNavigation({
        cwd: ctx.cwd,
        query: params.query,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: 'todo_schedule',
    label: 'Todo Scheduler',
    description:
      'Run bounded read-only delegates for independent ready todo nodes. Successful nodes remain doing until the parent reviews evidence; failures become blocked. Writable scheduling is deliberately unavailable.',
    promptSnippet:
      'Schedule independent ready todo tasks within explicit budgets',
    executionMode: 'sequential',
    parameters: Type.Object({
      maxChildren: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      maxDurationMs: Type.Optional(
        Type.Integer({ minimum: 10_000, maximum: 3_600_000 }),
      ),
      maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      maxComputeUnits: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 2_000 }),
      ),
      targetOutputTokens: Type.Optional(
        Type.Integer({ minimum: 1_000, maximum: 200_000 }),
      ),
      targetCostUsd: Type.Optional(
        Type.Number({ minimum: 0.01, maximum: 100 }),
      ),
      route: Type.String({
        minLength: 1,
        maxLength: 512,
        description: 'Exact route key from the user-owned delegate catalog.',
      }),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (pi.getFlag('autonomy-scheduler') !== true)
        throw new Error(
          'Enable --autonomy-scheduler for bounded read-only scheduling.',
        );
      const profileName = pi.getFlag('autonomy-profile') as
        | AutonomyProfileName
        | undefined;
      const result = await runReadyTaskScheduler({
        pi,
        ctx,
        profile: resolveProfile(profileName),
        requestedBudget: params,
        route: params.route,
        signal,
        onUpdate: (text, details) =>
          onUpdate?.({
            content: [{ type: 'text' as const, text }],
            details,
          }),
      });
      return {
        content: [{ type: 'text' as const, text: result.handoff }],
        details: result.details,
      };
    },
  });

  pi.registerCommand('workflow-doctor', {
    description:
      'Report workflow errors, active ambiguity, inactive duplicate warnings, and informational debt without mutation',
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const flags = {
        'context-governor': pi.getFlag('context-governor'),
        'autonomy-enforce': pi.getFlag('autonomy-enforce'),
        'autonomy-mode': autonomyMode(),
        'autonomy-scheduler': pi.getFlag('autonomy-scheduler'),
      };
      const result = formatWorkflowDiagnostics(
        collectWorkflowDiagnostics({
          cwd: ctx.cwd,
          systemPromptOptions: ctx.getSystemPromptOptions(),
          flags,
          commandNames: pi.getCommands().map((command) => command.name),
        }),
      );
      notify(ctx, result);
    },
  });
}
