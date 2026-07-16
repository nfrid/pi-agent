import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import {
  applicableRules,
  canonicalTarget,
  formatRules,
  loadManifest,
  type MutationIntent,
} from './core';

export const FLAG_NAME = 'scoped-instructions';
export const DIAGNOSTIC_ENTRY = 'scoped-instructions-diagnostic-v1';
const PROMPT_MARKER = '<scoped_instructions critical="true">';

interface Diagnostic {
  at: string;
  outcome: 'eager' | 'blocked' | 'applied' | 'rejected' | 'disabled';
  target?: string;
  intent?: MutationIntent;
  rules: Array<{ id: string; hash: string; reason: string }>;
  reason: string;
}

function enabled(pi: ExtensionAPI): boolean {
  return pi.getFlag(FLAG_NAME) === true;
}

function record(pi: ExtensionAPI, diagnostic: Omit<Diagnostic, 'at'>): void {
  pi.appendEntry(DIAGNOSTIC_ENTRY, {
    at: new Date().toISOString(),
    ...diagnostic,
  });
}

/** Shared with the system-prompt extension so the final rebuilt prompt retains critical rules. */
export function appendEagerCriticalRules(
  systemPrompt: string,
  cwd: string,
): { prompt: string; hashes: string[]; error?: string } {
  const manifest = loadManifest(cwd);
  if (!manifest) return { prompt: systemPrompt, hashes: [] };
  if (manifest.error)
    return {
      prompt: `${systemPrompt}\n\n${PROMPT_MARKER}\nMANIFEST REJECTED: ${manifest.error}\n</scoped_instructions>`,
      hashes: [],
      error: manifest.error,
    };
  const critical = manifest.rules.filter((rule) => rule.critical);
  const hashes = critical.map((rule) => rule.hash);
  if (critical.length === 0 || systemPrompt.includes(PROMPT_MARKER))
    return { prompt: systemPrompt, hashes };
  return {
    prompt: `${systemPrompt}\n\n${PROMPT_MARKER}\nThese repository rules are critical and apply before any covered edit/write mutation.\n\n${formatRules(critical)}\n</scoped_instructions>`,
    hashes,
  };
}

function commandDiagnostics(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  seen: ReadonlySet<string>,
  eager: ReadonlySet<string>,
): string {
  if (!enabled(pi))
    return 'Scoped instructions: disabled (default false). No edit/write interception is active.';
  const manifest = loadManifest(ctx.cwd);
  if (!manifest)
    return 'Scoped instructions: enabled; no Git repository found. Bash is not covered.';
  if (manifest.error)
    return `Scoped instructions: enabled; manifest rejected: ${manifest.error}\nPath: ${manifest.manifestPath}\nEdit/write are fail-closed. Bash is not covered.`;
  return [
    'Scoped instructions: enabled.',
    `Manifest: ${manifest.manifestPath}`,
    'Coverage: edit and write tool calls only. Bash mutations are explicitly NOT covered.',
    `Rules: ${manifest.rules.length}`,
    ...manifest.rules.map((rule) => {
      const reason = rule.critical
        ? eager.has(rule.hash)
          ? 'eagerly applied to system prompt'
          : 'critical, awaiting eager prompt load'
        : seen.has(rule.hash)
          ? 'loaded by a prior block; a covered mutation retry may apply while manifest/rule hashes remain unchanged'
          : 'not yet applicable/seen';
      return `- ${rule.id} [${rule.hash}] scope=${rule.scope} intents=${rule.intents.join(',')} critical=${rule.critical}: ${reason}; files=${rule.texts.map((file) => `${file.path}[${file.hash}]`).join(',')}`;
    }),
  ].join('\n');
}

export default function scopedInstructions(pi: ExtensionAPI): void {
  pi.registerFlag(FLAG_NAME, {
    type: 'boolean',
    default: false,
    description: 'Enable opt-in repository scoped instructions for edit/write',
  });

  const seen = new Set<string>();
  const eager = new Set<string>();

  pi.on('session_start', () => {
    seen.clear();
    eager.clear();
  });

  pi.on('before_agent_start', (event, ctx) => {
    if (!enabled(pi)) return;
    const result = appendEagerCriticalRules(event.systemPrompt, ctx.cwd);
    eager.clear();
    for (const hash of result.hashes) eager.add(hash);
    record(pi, {
      outcome: result.error ? 'rejected' : 'eager',
      rules: result.hashes.map((hash) => ({
        id: '(critical)',
        hash,
        reason: 'loaded into system prompt before agent start',
      })),
      reason:
        result.error ??
        `eagerly loaded ${result.hashes.length} critical rule(s)`,
    });
    return { systemPrompt: result.prompt };
  });

  pi.on('tool_call', (event: ToolCallEvent, ctx: ExtensionContext) => {
    if (
      !enabled(pi) ||
      (event.toolName !== 'edit' && event.toolName !== 'write')
    )
      return;
    const intent = event.toolName as MutationIntent;
    const manifest = loadManifest(ctx.cwd);
    if (!manifest) return;
    if (manifest.error) {
      const reason = `Scoped-instructions manifest rejected; ${intent} is blocked fail-closed: ${manifest.error}. Fix ${manifest.manifestPath}, then retry. Bash is not covered.`;
      record(pi, { outcome: 'rejected', intent, rules: [], reason });
      return { block: true, reason };
    }

    let target: ReturnType<typeof canonicalTarget>;
    try {
      const path = event.input.path;
      target = canonicalTarget(
        manifest.repositoryRoot,
        ctx.cwd,
        typeof path === 'string' ? path : '',
      );
    } catch (error) {
      const reason = `Scoped instructions blocked ${intent}: ${error instanceof Error ? error.message : String(error)}. Correct the target and retry. Bash is not covered.`;
      record(pi, { outcome: 'rejected', intent, rules: [], reason });
      return { block: true, reason };
    }

    const applicable = applicableRules(manifest, target.relative, intent);
    const missingCritical = applicable.filter(
      (rule) => rule.critical && !eager.has(rule.hash),
    );
    const unseen = applicable.filter(
      (rule) => !rule.critical && !seen.has(rule.hash),
    );
    if (missingCritical.length > 0 || unseen.length > 0) {
      for (const rule of unseen) seen.add(rule.hash);
      const blocked = [...missingCritical, ...unseen];
      const exactText = formatRules(blocked);
      const reason = [
        `Scoped instructions blocked this ${intent} before mutation. The following exact rules must be loaded:`,
        exactText,
        missingCritical.length > 0
          ? 'Critical rules were not present in the eager system-prompt snapshot. Start or retry an agent turn so they are eagerly loaded. A retry of a covered mutation is allowed only while manifest/rule hashes remain unchanged.'
          : 'Review these rules. A retry of a covered mutation is allowed only while manifest/rule hashes remain unchanged.',
        'Coverage is limited to edit/write tool calls; bash mutations are not covered.',
      ].join('\n\n');
      record(pi, {
        outcome: 'blocked',
        target: target.relative,
        intent,
        rules: blocked.map((rule) => ({
          id: rule.id,
          hash: rule.hash,
          reason: rule.critical
            ? 'critical missing from eager prompt'
            : 'first applicable encounter',
        })),
        reason: 'mutation prevented until applicable instructions are loaded',
      });
      return { block: true, reason };
    }

    record(pi, {
      outcome: 'applied',
      target: target.relative,
      intent,
      rules: applicable.map((rule) => ({
        id: rule.id,
        hash: rule.hash,
        reason: rule.critical ? 'eager system prompt' : 'prior block/retry',
      })),
      reason:
        applicable.length === 0
          ? 'no applicable rules'
          : 'all applicable rules loaded before mutation',
    });
  });

  pi.registerCommand('scoped-instructions', {
    description:
      'Explain scoped-instruction rules, hashes, reasons, and coverage',
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const text = commandDiagnostics(ctx, pi, seen, eager);
      if (ctx.hasUI) ctx.ui.notify(text, 'info');
      else console.log(text);
    },
  });
}
