import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defineExtension } from '../shared/runtime/extension';

export interface SkillEnvelope {
  name: string;
  location: string;
  instructions: string;
  start: number;
  end: number;
}

const SKILL_ENVELOPE_RE =
  /<skill name="([^"\r\n]+)" location="([^"\r\n]+)">\n([\s\S]*?)\n<\/skill>/g;
const CANONICAL_SKILL_MESSAGE_RE =
  /^<skill name="[^"\r\n]+" location="[^"\r\n]+">\n[\s\S]*?\n<\/skill>(?:\n\n[\s\S]+)?$/;

/**
 * Find the standard skill envelopes without changing the source message.
 *
 * Pi's built-in TUI renderer owns a single canonical envelope. This parser is
 * intentionally a small fallback for messages containing more than one
 * envelope (or other surrounding text), which the built-in parser leaves as
 * ordinary Markdown.
 */
export function findSkillEnvelopes(text: string): SkillEnvelope[] {
  return [...text.matchAll(SKILL_ENVELOPE_RE)].map((match) => ({
    name: match[1] ?? '',
    location: match[2] ?? '',
    instructions: match[3] ?? '',
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

/**
 * Render a display-only compact fallback while retaining the original message
 * in session history and model context. Surrounding text is the user request;
 * instructions are deliberately omitted from the collapsed fallback.
 */
export function compactSkillMessage(text: string): string {
  const envelopes = findSkillEnvelopes(text);
  if (envelopes.length === 0) return text;

  const parts: string[] = [];
  let cursor = 0;
  for (const envelope of envelopes) {
    const surrounding = text.slice(cursor, envelope.start).trim();
    if (surrounding) parts.push(surrounding);
    parts.push(`[skill] ${envelope.name}`);
    cursor = envelope.end;
  }
  const trailing = text.slice(cursor).trim();
  if (trailing) parts.push(trailing);
  return parts.join('\n\n');
}

/**
 * Register only the supported display hook. Canonical one-skill messages are
 * left untouched here because Pi renders those before UserMessageComponent,
 * using its own expandable SkillInvocationMessageComponent. Transforming that
 * text would remove the host's expanded instructions view.
 */
export function registerSkillMessageRendering(pi: ExtensionAPI): void {
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== 'user' || context.isStreaming) return markdown;
    const envelopes = findSkillEnvelopes(markdown);
    if (envelopes.length === 1 && CANONICAL_SKILL_MESSAGE_RE.test(markdown)) {
      return markdown;
    }
    return envelopes.length > 0 ? compactSkillMessage(markdown) : markdown;
  });
}

export default defineExtension(
  'skill-message-rendering',
  registerSkillMessageRendering,
);
