import { isRecord } from './utils.js';

export { SESSION_NAME_MAX_LENGTH } from './limits.js';

export const SESSION_TITLE_MAX_LENGTH = 96;

const SKILL_ENVELOPE_RE =
  /<skill name="([^"\r\n]+)" location="[^"\r\n]+">\r?\n[\s\S]*?\r?\n<\/skill>/gu;

/** Replace injected skill instructions with the same compact label shown in Pi. */
export function compactSessionTitleSkills(value: string): string {
  return value.replace(
    SKILL_ENVELOPE_RE,
    (_envelope, name: string) => `[skill] ${name}`,
  );
}

/** Normalize a user message into a compact, stable dashboard title. */
export function normalizeSessionTitle(value: string): string | undefined {
  const normalized = [...compactSessionTitleSkills(value).normalize('NFKC')]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return undefined;
  const characters = [...normalized];
  return characters.length <= SESSION_TITLE_MAX_LENGTH
    ? normalized
    : `${characters.slice(0, SESSION_TITLE_MAX_LENGTH - 1).join('')}…`;
}

function textFromMessageContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!isRecord(part) || typeof part.text !== 'string') return '';
      return part.text;
    })
    .filter(Boolean)
    .join(' ');
  return text || undefined;
}

/** Return the complete first non-empty user message in Pi session entries. */
export function firstUserMessageText(
  entries: readonly unknown[],
): string | undefined {
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== 'message') continue;
    const message = isRecord(entry.message) ? entry.message : entry;
    if (message.role !== 'user') continue;
    const text = textFromMessageContent(message.content);
    if (text?.trim()) return text;
  }
  return undefined;
}

/** Return the first non-empty user message title in Pi session entries. */
export function deriveSessionTitle(
  entries: readonly unknown[],
): string | undefined {
  const text = firstUserMessageText(entries);
  return text ? normalizeSessionTitle(text) : undefined;
}
